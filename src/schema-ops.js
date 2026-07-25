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
import { compile } from './compile.js';

// ---- the gate -------------------------------------------------------------------

function writeGated(ws, files, subject, mutate) {
	const snapshots = files.map((f) => ({ f, prev: fs.existsSync(f) ? fs.readFileSync(f) : null }));
	mutate();
	try {
		compile(ws); // dry-run that doubles as the materialization — throws CompileError on bad sources
	} catch (e) {
		for (const { f, prev } of snapshots) {
			if (prev === null) fs.rmSync(f, { force: true });
			else fs.writeFileSync(f, prev);
		}
		try { compile(ws); } catch { /* runtime was already broken before this op */ }
		throw e;
	}
	const rels = files.map((f) => path.relative(ws.root, f));
	execFileSync('git', ['add', '--', ...rels], { cwd: ws.root });
	execFileSync('git', ['commit', '--quiet', '-m', subject, '--', ...rels], { cwd: ws.root });
}

// the workspace's writable system dir (workspace-module aware)
export function workspaceSystemDir(ws, kind) {
	const wm = ws.pkg.dreamteamer?.['workspace-module'];
	return wm ? path.join(ws.root, 'modules', wm, 'system', kind) : path.join(ws.root, 'system', kind);
}

// ---- ops ------------------------------------------------------------------------

export function createCollection(ws, store, { name, template }) {
	if (!name) throw new Error('missing collection name');
	if (store.descriptors.has(name)) throw new Error(`collection "${name}" already exists`);
	const dest = path.join(workspaceSystemDir(ws, 'collections'), `${name}.collection.yaml`);
	if (fs.existsSync(dest)) throw new Error(`${path.relative(ws.root, dest)} already exists`);

	let descriptor = { name };
	if (template) {
		const tplFile = path.join(ws.root, '.dreamteamer', 'system', 'collection-templates', `${template}.collection-template.yaml`);
		if (!fs.existsSync(tplFile)) throw new Error(`unknown collection-template "${template}"`);
		descriptor = { name, ...structuredClone(load(fs.readFileSync(tplFile, 'utf8')).template) };
	} else {
		// templateless: MINIMAL but compilable — grow it with add-field
		descriptor.id = { generate: '{{ name | slug }}' };
		descriptor.schema = { type: 'object', required: ['name'], properties: { name: { type: 'string' } } };
	}
	descriptor.storage = {
		path: `${ws.pkg.dreamteamer?.['data-path'] ?? 'data'}/${name}`,
		codec: 'md', shape: 'file',
		...descriptor.storage,
		suffix: descriptor.storage?.suffix ?? singular(name),
	};
	writeGated(ws, [dest], `dreamteamer: collections add ${name}`, () => {
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
	writeGated(ws, [dest], `dreamteamer: collections rm ${name}`, () => fs.rmSync(dest));
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
	return upsertField(ws, store, collection, fieldName, prop, required, `update-field ${fieldName}`);
}

export function removeField(ws, store, collection, fieldName) {
	const d = store.descriptor(collection);
	if (!d.schema?.properties?.[fieldName]) throw new Error(`no field "${fieldName}" on ${collection}`);
	const dest = path.join(workspaceSystemDir(ws, 'collections'), `${collection}.collection.yaml`);
	if (!fs.existsSync(dest)) throw new Error(`"${collection}" is module-shipped; the workspace can only OVERRIDE fields (extends), not remove them`);
	const doc = load(fs.readFileSync(dest, 'utf8'));
	if (!doc.schema?.properties?.[fieldName]) throw new Error(`field "${fieldName}" is inherited from the base module — the workspace descriptor doesn't declare it`);
	writeGated(ws, [dest], `dreamteamer: ${collection} remove-field ${fieldName}`, () => {
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
	const dest = path.join(workspaceSystemDir(ws, 'collections'), `${collection}.collection.yaml`);
	let doc;
	if (fs.existsSync(dest)) {
		doc = load(fs.readFileSync(dest, 'utf8'));
	} else {
		doc = { name: collection, extends: baseModuleRef(ws.root, collection), schema: { properties: {} } };
	}
	writeGated(ws, [dest], `dreamteamer: ${collection} ${verb}`, () => {
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

// base module for an extends pointer — resolved via manifest.modules across ALL channels
// (audit open finding 1: the old regex only understood inline modules/… paths)
function baseModuleRef(root, collection) {
	const manifest = load(fs.readFileSync(path.join(root, '.dreamteamer', 'manifest.yaml'), 'utf8'));
	const entry = manifest.entries?.[`system/collections/${collection}.collection.yaml`];
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
			case 'datetime': return { type: 'string', format: 'date-time' };
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
	return p;
}

function singular(name) {
	return name.endsWith('ies') ? name.slice(0, -3) + 'y' : name.endsWith('s') ? name.slice(0, -1) : name;
}
