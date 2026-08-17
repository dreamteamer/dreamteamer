// schema operations — source-writing mutations shared by the CLI meta verbs and the
// server's schema endpoints. the contract (audit finding 11, clean-room bug 2): an op
// writes sources, proves them with a REAL compile, and only then commits — an
// uncompilable source can never land in history. the successful gate compile also
// leaves the runtime fresh, which kills the add-field-right-after-collections-add
// papercut (review finding 7): schema ops ARE explicit compiles.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { load, dump } from './yaml.js';
import { compile, kindDir, titleCase } from './compile.js';
import { readManifest, runtimeKindDir } from './runtime.js';
import { normalizeNamespaces, namespaceOf, baseNameOf, qualify, defaultStoragePath } from './namespace.js';

// ---- the gate -------------------------------------------------------------------

function writeGated(ws, store, files, subject, mutate) {
	// same guarantees as record writes (docs-audit catch): the STORE's cross-process lock
	// serializes schema ops too, and a failed git commit rolls the source back — a schema
	// op fails closed exactly like a record mutation.
	return store.withWriteLock(() => {
		const snapshots = files.map((f) => ({ f, prev: fs.existsSync(f) ? fs.readFileSync(f) : null }));
		const restore = () => {
			for (const { f, prev } of snapshots) {
				if (prev === null) fs.rmSync(f, { force: true });
				else fs.writeFileSync(f, prev);
			}
		};
		mutate();
		try {
			compile(ws); // dry-run that doubles as the materialization — throws CompileError on bad sources
		} catch (e) {
			restore();
			try { compile(ws); } catch { /* runtime was already broken before this op */ }
			throw e;
		}
		const rels = files.map((f) => path.relative(ws.root, f));
		// Schema ops commit UNCONDITIONALLY — `auto-commit` governs RECORD writes only. A source
		// change is inseparable from the compile that validated it, and `dt commit` scopes itself
		// to record directories, so a deferred source edit would be publishable by nothing.
		// Extending `dt commit` to module sources is the natural follow-on; it is not this wave.
		try {
			execFileSync('git', ['add', '--', ...rels], { cwd: ws.root });
			execFileSync('git', ['commit', '--quiet', '-m', subject, '--', ...rels], { cwd: ws.root });
		} catch (e) {
			try { execFileSync('git', ['reset', '--quiet', '--', ...rels], { cwd: ws.root }); } catch { /* nothing staged */ }
			restore();
			try { compile(ws); } catch { /* pre-op sources were compilable */ }
			throw new Error(`git commit failed — the schema change was rolled back, nothing was changed. (${e.message.split('\n')[0]})`);
		}
	});
}

/** The workspace's writable source dir for a kind (workspace-module aware). `kindDir` picks the
 *  layout that module already uses and falls back to flat, so a `collections add` never splits a
 *  half-moved module across both. */
export function workspaceSystemDir(ws, kind) {
	const wm = ws.pkg.dreamteamer?.['workspace-module'];
	return kindDir(wm ? path.join(ws.root, 'modules', wm) : ws.root, kind);
}

// ---- ops ------------------------------------------------------------------------

export function createCollection(ws, store, { name, template, namespace }) {
	if (!name) throw new Error('missing collection name');
	// `--namespace health --name doctors` and `--name health/doctors` are the SAME collection, because
	// the qualified name IS the identity everywhere else in the engine. Accepting both keeps the CLI
	// honest about that rather than making the operator learn which spelling a verb wants.
	const declared = normalizeNamespaces(ws.pkg.dreamteamer?.namespaces);
	const qualified = namespace ? qualify(namespace, name) : name;
	const ns = namespaceOf(qualified, declared);
	if (qualified.includes('/') && !ns) {
		throw new Error(`namespace "${qualified.slice(0, qualified.lastIndexOf('/'))}" is not declared — add it to dreamteamer.namespaces in package.json first, or the collection will not compile.`);
	}
	if (store.descriptors.has(qualified)) throw new Error(`collection "${qualified}" already exists`);
	// NESTED, mirroring where compile puts it in the runtime: `collections/health/doctors.collection.yaml`.
	// compile enumerates this kind recursively for exactly this reason — and `upsertField` derives the
	// same path from the same name, which is what keeps a later `add-field` editing the base descriptor
	// instead of quietly creating an overlay beside it.
	const dest = path.join(workspaceSystemDir(ws, 'collections'), `${qualified}.collection.yaml`);
	if (fs.existsSync(dest)) throw new Error(`${path.relative(ws.root, dest)} already exists`);

	let descriptor = { name: qualified };
	if (template) {
		const tplFile = path.join(runtimeKindDir(ws.root, 'collection-templates'), `${template}.collection-template.yaml`);
		if (!fs.existsSync(tplFile)) throw new Error(`unknown collection-template "${template}"`);
		descriptor = { name: qualified, ...structuredClone(load(fs.readFileSync(tplFile, 'utf8')).template) };
	} else {
		// templateless: MINIMAL but compilable — grow it with add-field
		descriptor.id = { generate: '{{ name | slug }}' };
		descriptor.schema = { type: 'object', required: ['name'], properties: { name: { type: 'string' } } };
	}
	descriptor.storage = {
		// AUTHORED even though compile would derive the same value, because a descriptor a human opens
		// should say where its records live without them having to know the derivation rule.
		path: defaultStoragePath(qualified, declared, ws.pkg.dreamteamer?.['data-path'] ?? 'data'),
		codec: 'md', shape: 'file',
		...descriptor.storage,
		// the SUFFIX comes off the bare name — `health/doctors` records are `<id>.doctor.md`, not
		// `<id>.health/doctor.md`
		suffix: descriptor.storage?.suffix ?? singular(baseNameOf(qualified, declared)),
	};
	writeGated(ws, store, [dest], `dreamteamer: collections add ${qualified}`, () => {
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, dump(descriptor));
	});
	return { file: dest, descriptor };
}

export function removeCollection(ws, store, name, { force = false } = {}) {
	const d = store.descriptor(name);
	const dest = path.join(workspaceSystemDir(ws, 'collections'), `${name}.collection.yaml`);
	if (!fs.existsSync(dest)) throw new Error(`"${name}" is not workspace-owned — it ships with a module; add "<module>/${name}" to dreamteamer.disable instead`);
	const dataDir = path.join(ws.root, d.storage.path);
	const hasRecords = fs.existsSync(dataDir) && fs.readdirSync(dataDir).some((e) => !e.startsWith('.'));
	if (hasRecords && !force) throw new Error(`collection "${name}" still has records under ${d.storage.path} — remove them first or pass force`);
	writeGated(ws, store, [dest], `dreamteamer: collections rm ${name}`, () => fs.rmSync(dest));
	return { removed: name };
}

export function addField(ws, store, collection, { name: fieldName, prop, required }) {
	store.descriptor(collection); // must exist in the compiled runtime
	if (!fieldName) throw new Error('missing field name');
	if (store.descriptor(collection).schema?.properties?.[fieldName]) throw new Error(`field "${fieldName}" already exists on ${collection}`);
	return upsertField(ws, store, collection, fieldName, prop, required, `add-field ${fieldName}`);
}

export function updateField(ws, store, collection, fieldName, { prop, required }) {
	const d = store.descriptor(collection);
	if (!d.schema?.properties?.[fieldName]) throw new Error(`no field "${fieldName}" on ${collection}`);
	// upsertField REPLACES the prop, so retyping a field would silently drop its hand-authored
	// `description`. Changing a field's type is not a decision to undocument it. Same for an
	// authored `title` — but ONLY an authored one: a derived title is compile's output, not a
	// human's choice, and `titleCase` is how the two are told apart.
	const previous = d.schema.properties[fieldName];
	if (prop.description === undefined && typeof previous.description === 'string') prop = { ...prop, description: previous.description };
	if (prop.title === undefined && typeof previous.title === 'string' && previous.title !== titleCase(fieldName)) prop = { ...prop, title: previous.title };
	return upsertField(ws, store, collection, fieldName, prop, required, `update-field ${fieldName}`);
}

export function removeField(ws, store, collection, fieldName) {
	const d = store.descriptor(collection);
	if (!d.schema?.properties?.[fieldName]) throw new Error(`no field "${fieldName}" on ${collection}`);
	const dest = path.join(workspaceSystemDir(ws, 'collections'), `${collection}.collection.yaml`);
	if (!fs.existsSync(dest)) throw new Error(`"${collection}" is module-shipped; the workspace can only OVERRIDE fields (extends), not remove them`);
	const doc = load(fs.readFileSync(dest, 'utf8'));
	if (!doc.schema?.properties?.[fieldName]) throw new Error(`field "${fieldName}" is inherited from the base module — the workspace descriptor doesn't declare it`);
	writeGated(ws, store, [dest], `dreamteamer: ${collection} remove-field ${fieldName}`, () => {
		delete doc.schema.properties[fieldName];
		if (Array.isArray(doc.schema.required)) doc.schema.required = doc.schema.required.filter((r) => r !== fieldName);
		fs.writeFileSync(dest, dump(doc));
	});
	return { collection, removed: fieldName };
}

function upsertField(ws, store, collection, fieldName, prop, required, verb) {
	if (prop == null || typeof prop !== 'object' || Array.isArray(prop)) {
		throw new Error(`field "${fieldName}": prop must be a JSON-Schema object (got ${Array.isArray(prop) ? 'array' : typeof prop}) — nothing was written.`);
	}
	// compile resolves `prop.title` into the COMPILED descriptor, and both writers rebuild a prop
	// from that projection — this one and the studio's field drawer. Without this, retyping any
	// field through the UI writes the DERIVED label back into the source as though a human chose
	// it, and 51 collections fill with `title: Due Date` noise no longer distinguishable from a
	// real override. The webview applies the identical rule in `lib/field-prop.ts`.
	if (prop.title === titleCase(fieldName)) {
		prop = { ...prop };
		delete prop.title;
	}
	// Same rule for the value template. presentation INHERITS a reference's template from its
	// target collection's `title_template`, so a field drawer that round-trips that projection
	// writes the inherited value back onto the field — hand-recreating exactly the 49 duplicated
	// `x-display` lines the inheritance replaced. Only a template that DIFFERS from the target's
	// is a real authored override.
	const ref = prop['x-reference'] ?? prop.items?.['x-reference'];
	const inherited = ref && ref !== '*' ? store.descriptors.get(ref)?.title_template : undefined;
	if (inherited) {
		if (prop['x-title-template'] === inherited) {
			prop = { ...prop };
			delete prop['x-title-template'];
		}
		if (prop.items?.['x-title-template'] === inherited) {
			prop = { ...prop, items: { ...prop.items } };
			delete prop.items['x-title-template'];
		}
	}
	const dest = path.join(workspaceSystemDir(ws, 'collections'), `${collection}.collection.yaml`);
	let doc;
	if (fs.existsSync(dest)) {
		doc = load(fs.readFileSync(dest, 'utf8'));
	} else {
		doc = { name: collection, extends: baseModuleRef(ws.root, collection), schema: { properties: {} } };
	}
	writeGated(ws, store, [dest], `dreamteamer: ${collection} ${verb}`, () => {
		doc.schema ??= { properties: {} };
		doc.schema.properties ??= {};
		doc.schema.properties[fieldName] = prop;
		if (required === true) doc.schema.required = [...new Set([...(doc.schema.required ?? []), fieldName])];
		if (required === false && Array.isArray(doc.schema.required)) doc.schema.required = doc.schema.required.filter((r) => r !== fieldName);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, dump(doc));
	});
	return { collection, field: fieldName, file: dest, extends: doc.extends };
}

// saved views (M3): a studio-saved view IS a ui-view record — but ui-views are
// system-stored (sources + compile), so the write goes through the same gate as any
// other schema op. the studio "save view" button lands here.
export function saveUiView(ws, store, { id, view }) {
	if (!id || !/^[a-z0-9][a-z0-9-/]*$/.test(id)) throw new Error(`invalid ui-view id "${id}" — lowercase slug required`);
	const dest = path.join(workspaceSystemDir(ws, 'ui-views'), `${id}.ui-view.yaml`);
	const existed = fs.existsSync(dest);
	writeGated(ws, store, [dest], `dreamteamer: ui-views ${existed ? 'update' : 'add'} ${id}`, () => {
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, dump(view));
	});
	return { id, file: dest, updated: existed };
}

export function removeUiView(ws, store, id) {
	const dest = path.join(workspaceSystemDir(ws, 'ui-views'), `${id}.ui-view.yaml`);
	if (!fs.existsSync(dest)) throw new Error(`ui-view "${id}" is not workspace-owned (module-shipped views are removed via dreamteamer.disable)`);
	writeGated(ws, store, [dest], `dreamteamer: ui-views rm ${id}`, () => fs.rmSync(dest));
	return { removed: id };
}

// base module for an extends pointer — resolved via manifest.modules across ALL channels
// (audit open finding 1: the old regex only understood inline modules/… paths)
function baseModuleRef(root, collection) {
	const manifest = readManifest(root) ?? {};
	// entry keys are runtime-relative and lost their `system/` prefix in the flatten; a manifest
	// written by an older engine still carries it, and this reads whatever is on disk
	const entry = manifest.entries?.[`collections/${collection}.collection.yaml`]
		?? manifest.entries?.[`system/collections/${collection}.collection.yaml`];
	const src = entry?.sources?.[0];
	const srcPath = typeof src === 'string' ? src : src?.path;
	if (!srcPath) throw new Error(`cannot determine the base module for "${collection}"`);
	for (const m of manifest.modules ?? []) {
		const modRoot = m.root === '.' ? '' : `${m.root}/`;
		if (modRoot && srcPath.startsWith(modRoot)) return `${m.name}/${collection}`;
	}
	throw new Error(`cannot determine the base module for "${collection}" — its source is ${srcPath}; edit that descriptor directly`);
}

// CLI/API type sugar → JSON Schema property
export function fieldDef(store, flags) {
	const t = flags.type ?? 'string';
	const def = flags['default-value'] ?? flags.default;
	const p = (() => {
		switch (t) {
			case 'string': case 'text': return { type: 'string' };
			case 'markdown': return { type: 'string', format: 'markdown' };
			case 'boolean': return { type: 'boolean' };
			case 'number': return { type: 'number' };
			case 'integer': return { type: 'integer' };
			case 'date': return { type: 'string', format: 'date' };
			// `timestamp` is the WIRE type presentation.js projects `date-time` to, and therefore what
			// the studio's field drawer round-trips. Accepting it here means the vocabulary you read
			// out of `presentation` is the vocabulary you can type back into the CLI.
			case 'datetime': case 'timestamp': return { type: 'string', format: 'date-time' };
			case 'enum': {
				if (!flags.options) throw new Error('enum needs options "a,b,c"');
				const opts = Array.isArray(flags.options) ? flags.options : flags.options.split(',').map((s) => s.trim());
				return { type: 'string', enum: opts };
			}
			case 'tags': return { type: 'array', items: { type: 'string' } };
			default:
				if (store.descriptors.has(t)) return { type: 'string', 'x-reference': t };
				if (t === 'reference') return { type: 'string', 'x-reference': flags.target ?? '*' };
				throw new Error(`unknown field type "${t}"`);
		}
	})();
	if (def !== undefined) p.default = p.type === 'boolean' ? def === 'true' || def === true : p.type === 'number' || p.type === 'integer' ? Number(def) : def;
	// what the field MEANS, in one line — JSON Schema's own keyword, projected to every surface by
	// presentation.js. A field whose name doesn't say enough is documented here, not in a comment.
	if (typeof flags.description === 'string' && flags.description.length > 0) p.description = flags.description;
	return p;
}

function singular(name) {
	return name.endsWith('ies') ? name.slice(0, -3) + 'y' : name.endsWith('s') ? name.slice(0, -1) : name;
}
