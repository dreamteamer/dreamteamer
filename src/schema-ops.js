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
import { walk, EXT } from './records.js';

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

/**
 * Rename a collection — descriptor, records, and every inbound reference, in ONE commit.
 *
 * This exists because namespacing EXISTING data was otherwise a hand migration: `git mv` the
 * descriptor, edit `name` and `storage.path`, `git mv` the record folder, re-suffix every file, then
 * find and rewrite every reference — six steps with no gate, where forgetting the last one dangles
 * every link silently. `dt collections rename doctors health/doctors` is the whole thing.
 *
 * DERIVED-VS-AUTHORED is the rule for both moving parts, the same rule `createCollection` uses:
 *  - `storage.path` moves only if it was DERIVED (equal to the default for the old name). An authored
 *    path is a deliberate choice about where records live and a rename must not overrule it.
 *  - `storage.suffix` is re-derived only if it was DERIVED (the singular of the old base name), because
 *    otherwise the filenames would start lying about what they hold. `doctors` → `health/doctors` keeps
 *    the base name, so nothing is re-suffixed — which is the common case and the cheap one.
 *
 * References are rewritten by asking the STORE to do it, once per record id, rather than by matching
 * the collection prefix with a new regex. `store.rewriteRefs` already knows the boundary rules and
 * already scopes prose to `[[wikilinks]]` (decision 7) — a fresh `oldName/` pattern would have to
 * relearn both, and would corrupt `data/tasks/` in a path or a URL on its first outing. N passes over
 * the record files is the price, and at human scale it is worth paying for reusing the correct code.
 */
export function renameCollection(ws, store, oldName, newName) {
	const d = store.descriptor(oldName); // throws with the known-collection list if absent
	if (!newName) throw new Error('missing new collection name');
	if (oldName === newName) return { renamed: false, name: newName };

	const declared = normalizeNamespaces(ws.pkg.dreamteamer?.namespaces);
	if (newName.includes('/') && !namespaceOf(newName, declared)) {
		throw new Error(`namespace "${newName.slice(0, newName.lastIndexOf('/'))}" is not declared — add it to dreamteamer.namespaces in package.json first.`);
	}
	if (store.descriptors.has(newName)) throw new Error(`collection "${newName}" already exists`);
	if (d.storage.base === 'runtime') throw new Error(`"${oldName}" is a compiled source, not a data collection — it cannot be renamed`);

	const src = path.join(workspaceSystemDir(ws, 'collections'), `${oldName}.collection.yaml`);
	const dest = path.join(workspaceSystemDir(ws, 'collections'), `${newName}.collection.yaml`);
	if (!fs.existsSync(src)) {
		throw new Error(`"${oldName}" is not workspace-owned — it ships with a module, so rename it there (or overlay it with \`extends\`)`);
	}

	const doc = load(fs.readFileSync(src, 'utf8'));
	const dataPath = ws.pkg.dreamteamer?.['data-path'] ?? 'data';
	// `d` is the COMPILED descriptor, so its storage.path already carries any module prefix; the
	// authored source is what we compare against, and what we rewrite.
	const authoredPath = String(doc.storage?.path ?? '');
	const pathWasDerived = authoredPath === '' || authoredPath === defaultStoragePath(oldName, declared, dataPath);
	const newPath = pathWasDerived ? defaultStoragePath(newName, declared, dataPath) : authoredPath;

	const oldBase = baseNameOf(oldName, declared);
	const newBase = baseNameOf(newName, declared);
	const oldSuffix = d.storage.suffix;
	const suffixWasDerived = oldSuffix === singular(oldBase);
	const newSuffix = suffixWasDerived ? singular(newBase) : oldSuffix;

	// Every id BEFORE anything moves — the store's index is keyed on the old collection.
	const ids = [...store.ids(oldName).keys()];
	const oldDir = store.dir(d);
	const newDir = path.join(ws.root, newPath);
	if (newDir !== oldDir && fs.existsSync(newDir)) {
		throw new Error(`${newPath} already exists on disk — move or remove it first; nothing was renamed`);
	}

	// ---- rollback state, captured before the first mutation --------------------------------------
	const srcBytes = fs.readFileSync(src);
	let movedData = false;
	let resuffixed = [];
	const undo = () => {
		for (const [from, to] of resuffixed) { if (fs.existsSync(to)) fs.renameSync(to, from); }
		if (movedData && fs.existsSync(newDir)) {
			fs.mkdirSync(path.dirname(oldDir), { recursive: true });
			fs.renameSync(newDir, oldDir);
			pruneEmpty(path.dirname(newDir), path.join(ws.root, dataPath));
		}
		fs.mkdirSync(path.dirname(src), { recursive: true });
		fs.writeFileSync(src, srcBytes);
		if (dest !== src) fs.rmSync(dest, { force: true });
	};

	return store.withWriteLock(() => {
		// referencing files are snapshotted by the store's own helper via rewriteRefs' touched list, so
		// they are captured here the same way `store.rename` does it: read before, restore on failure.
		const refFiles = new Map();
		const captureRefs = (ref) => {
			for (const f of store.findInboundRefs(ref)) {
				const abs = path.join(ws.root, f);
				if (!refFiles.has(abs)) refFiles.set(abs, fs.readFileSync(abs));
			}
		};
		for (const id of ids) captureRefs(`${oldName}/${id}`);
		captureRefs(`collections/${oldName}`);
		const restoreRefs = () => { for (const [f, bytes] of refFiles) fs.writeFileSync(f, bytes); };

		const touched = new Set();
		let rewrites = 0;
		try {
			// 1. the descriptor source, at its new path
			doc.name = newName;
			doc.storage = { ...doc.storage, path: newPath, suffix: newSuffix };
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			fs.writeFileSync(dest, dump(doc));
			if (dest !== src) fs.rmSync(src);
			touched.add(src);
			touched.add(dest);

			// 2. the record folder, then the per-file suffix if it was derived
			if (newDir !== oldDir && fs.existsSync(oldDir)) {
				fs.mkdirSync(path.dirname(newDir), { recursive: true });
				fs.renameSync(oldDir, newDir);
				movedData = true;
				pruneEmpty(path.dirname(oldDir), path.join(ws.root, dataPath));
			}
			if (newSuffix !== oldSuffix && fs.existsSync(newDir)) {
				const ext = EXT[d.storage.codec ?? 'md'];
				for (const file of walk(newDir)) {
					if (!file.endsWith(`.${oldSuffix}${ext}`)) continue;
					const to = file.slice(0, -(oldSuffix.length + ext.length + 1)) + `.${newSuffix}${ext}`;
					fs.renameSync(file, to);
					resuffixed.push([file, to]);
				}
			}
			if (movedData) { touched.add(oldDir); touched.add(newDir); }

			// 3. inbound references: per record id, plus the collection's own id in `collections`
			//    (which is what ui-views and command-bindings point at).
			for (const id of ids) {
				const out = store.rewriteRefs(`${oldName}/${id}`, `${newName}/${id}`);
				rewrites += out.rewrites;
				for (const f of out.touched) touched.add(f);
			}
			const collOut = store.rewriteRefs(`collections/${oldName}`, `collections/${newName}`);
			rewrites += collOut.rewrites;
			for (const f of collOut.touched) touched.add(f);

			// 4. bare `x-reference: <oldName>` in every descriptor SOURCE. Not a `<collection>/<id>`
			//    ref, so step 3 cannot see it — and leaving it makes compile fail on an unknown target.
			for (const f of descriptorSources(ws, store)) {
				const before = fs.readFileSync(f, 'utf8');
				const doc2 = load(before);
				if (!doc2 || !retargetRefs(doc2.schema, oldName, newName)) continue;
				if (!refFiles.has(f)) refFiles.set(f, Buffer.from(before));
				fs.writeFileSync(f, dump(doc2));
				touched.add(f);
				rewrites++;
			}

			compile(ws); // the gate: an uncompilable rename never reaches history
		} catch (e) {
			restoreRefs();
			undo();
			try { compile(ws); } catch { /* pre-rename sources were compilable */ }
			throw e;
		}

		// `git add -- <path>` FAILS OUTRIGHT on a pathspec that is neither on disk nor in the index —
		// which is exactly what the old descriptor becomes when it was never committed in the first
		// place (a collection added but not yet published). One bad entry aborts the whole `add`, so
		// the rename rolled back over a file git simply did not care about. Filter, don't assume.
		const rels = [...touched]
			.map((f) => path.relative(ws.root, f))
			.filter((rel) => fs.existsSync(path.join(ws.root, rel)) || isTracked(ws.root, rel));
		try {
			execFileSync('git', ['add', '--all', '--', ...rels], { cwd: ws.root });
			execFileSync('git', ['commit', '--quiet', '-m', `dreamteamer: collections rename ${oldName} → ${newName}`, '--', ...rels], { cwd: ws.root });
		} catch (e) {
			try { execFileSync('git', ['reset', '--quiet', '--', ...rels], { cwd: ws.root }); } catch { /* nothing staged */ }
			restoreRefs();
			undo();
			try { compile(ws); } catch { /* pre-rename sources were compilable */ }
			throw new Error(`git commit failed — the rename was rolled back, nothing was changed. (${e.message.split('\n')[0]})`);
		}

		return {
			renamed: true, name: newName, records: ids.length, rewrites,
			from: path.relative(ws.root, oldDir), to: path.relative(ws.root, newDir),
			suffix: newSuffix !== oldSuffix ? { from: oldSuffix, to: newSuffix } : null,
			pathKept: pathWasDerived ? null : authoredPath,
		};
	});
}

/** Does git know this path? A deleted-and-never-committed file must be dropped from a pathspec. */
function isTracked(root, rel) {
	try {
		execFileSync('git', ['ls-files', '--error-unmatch', '--', rel], { cwd: root, stdio: ['ignore', 'ignore', 'ignore'] });
		return true;
	} catch { return false; }
}

/** Every workspace-owned descriptor source, recursively (namespaced descriptors are nested). */
function descriptorSources(ws, store) {
	const out = [];
	for (const root of store.sourceRoots()) {
		const dir = kindDir(root, 'collections');
		if (fs.existsSync(dir)) out.push(...walk(dir).filter((f) => f.endsWith('.collection.yaml')));
	}
	return out;
}

/** Rewrite `x-reference: old` → new anywhere in a schema. Returns true if anything changed. */
function retargetRefs(schema, oldName, newName) {
	let changed = false;
	for (const prop of Object.values(schema?.properties ?? {})) {
		if (!prop || typeof prop !== 'object') continue;
		for (const holder of [prop, prop.items]) {
			if (holder && typeof holder === 'object' && holder['x-reference'] === oldName) {
				holder['x-reference'] = newName;
				changed = true;
			}
		}
		if (prop.properties && retargetRefs(prop, oldName, newName)) changed = true;
		if (prop.items?.properties && retargetRefs(prop.items, oldName, newName)) changed = true;
	}
	return changed;
}

/** Remove now-empty parents up to (not including) the data root — a moved collection leaves its
 *  namespace folder behind otherwise. */
function pruneEmpty(dir, stopAt) {
	while (dir !== stopAt && dir.startsWith(stopAt) && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
		fs.rmdirSync(dir);
		dir = path.dirname(dir);
	}
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
