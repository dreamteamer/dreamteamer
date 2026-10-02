#!/usr/bin/env node
// migrate-descriptors-v2 — rewrite a workspace's v1 descriptor sources in descriptor format v2.
//
//   node node_modules/dreamteamer/scripts/migrate-descriptors-v2.mjs [--root <workspace>] [--dry-run]
//
// What it rewrites: every `*.collection.yaml` under the workspace's own sources (`modules/*/` and a
// classic root layout), and every `*.collection-template.yaml`, which becomes a `mixins/<id>.mixin.yaml`.
// What it never touches: anything under `data/`, `node_modules/` or `git_modules/` (somebody else's
// sources — convert those in their own repo), and the bytes of any record.
//
// It edits the YAML DOCUMENT, not a re-dump, so a comment stays on the key it was written above, and
// it is idempotent: a source that already has `fields` is v2 and is left alone. A relation declared
// on its OWNER (v1 spelling A, `x-inverse`) is folded into the one v2 spelling — a `mirror_of` field
// on the target's descriptor — when the target is in the same tree; otherwise it is reported.
//
// The pure half (`convertCollection`, `convertTemplate`, `addMirrorField`) is exported for the tests.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument, isMap, isSeq, isScalar, isPair } from 'yaml';
import { singular } from '../src/namespace.js';

const STRINGIFY = { lineWidth: 0, flowCollectionPadding: false };
const V2_ORDER = ['name', 'title', 'singular', 'record_title', 'description', 'use_when', 'internal', 'sensitive', 'storage', 'ids', 'mixins', 'overlay', 'fields', 'constraints', 'display'];
const FIELD_ORDER = ['type', 'title', 'required', 'many', 'default', 'enum', 'unique', 'mirror_of', 'on_delete', 'sensitive', 'body', 'derived', 'virtual', 'deprecated', 'passthrough', 'fields', 'values', 'item_title', 'examples', 'pattern', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'const', 'display', 'description'];
const PASS = ['title', 'default', 'examples', 'pattern', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'const', 'description'];

const keyOf = (pair) => String(isScalar(pair.key) ? pair.key.value : pair.key);
const pairOf = (map, k) => map?.items?.find((p) => keyOf(p) === k);
const toJS = (node) => (node && typeof node.toJSON === 'function' ? node.toJSON() : node);

/** The suffix a v1 engine derived for an unauthored `storage.suffix` — what every existing record's
 *  filename carries. The converter writes it explicitly wherever v2's inflector would derive another,
 *  so no record is renamed by an upgrade. */
function v1Suffix(name) {
	return name.endsWith('ies') ? name.slice(0, -3) + 'y' : name.endsWith('s') ? name.slice(0, -1) : name;
}

/**
 * Rewrite a map node's pairs to match `value`, in `order`, REUSING the pair (and so the comments)
 * of every key whose value is unchanged and the key's comments wherever a key was renamed. `renamed`
 * maps a new key to the old key whose comments it inherits.
 */
function rewriteMap(doc, map, value, order, renamed = {}) {
	const keys = Object.keys(value).sort((a, b) => rank(order, a) - rank(order, b));
	map.items = keys.map((k) => {
		const old = pairOf(map, k) ?? pairOf(map, renamed[k]);
		const v = value[k];
		if (old && JSON.stringify(toJS(old.value)) === JSON.stringify(v) && keyOf(old) === k) return old;
		const pair = doc.createPair(k, v);
		if (old) {
			for (const c of ['commentBefore', 'spaceBefore']) if (old.key?.[c] !== undefined) pair.key[c] = old.key[c];
			if (old.value?.comment !== undefined && isScalar(pair.value)) pair.value.comment = old.value.comment;
			// a nested map that is merely re-keyed keeps its own node, comments and all
			if (isMap(old.value) && isMap(pair.value) && v && typeof v === 'object' && !Array.isArray(v)) {
				pair.value = old.value;
				// the new value is already in its canonical order (convertField sorts a field's keys)
				rewriteMap(doc, old.value, v, Object.keys(v));
			}
		}
		return pair;
	});
	return map;
}
const rank = (order, k) => { const i = order.indexOf(k); return i === -1 ? order.length : i; };

/**
 * One v1 field definition (plain JS) → its v2 form, plus what the conversion needs to report.
 * @returns {{ field: object, fold?: { name, description?, unique } , warnings: string[] }}
 */
export function convertField(p, { required = false } = {}) {
	const warnings = [];
	const many = p.type === 'array';
	const holder = many && p.items && typeof p.items === 'object' ? p.items : p;
	const out = {};
	// a SOFT reference names something that may legitimately not exist (a peer nobody installed), which
	// is exactly what a plain string says — v2 has no soft reference
	const ref = holder['x-reference-soft'] === true ? undefined : holder['x-reference'];
	if (ref !== undefined) {
		out.type = ref === '*' ? 'reference' : ref;
	} else if (holder.type === 'object') {
		if (holder.properties) {
			out.type = 'object';
			const req = new Set(holder.required ?? []);
			out.fields = Object.fromEntries(Object.entries(holder.properties).map(([k, v]) => [k, convertField(v, { required: req.has(k) }).field]));
		} else if (holder.additionalProperties && typeof holder.additionalProperties === 'object') {
			out.type = 'map';
			const inner = convertField(holder.additionalProperties).field;
			out.values = Object.keys(inner).length === 1 ? inner.type : inner;
		} else out.type = 'map';
	} else if (many && (!p.items || typeof p.items !== 'object' || p.items.type === undefined)) {
		// an UNTYPED list: v2 has no "any value" element, and every measured one holds strings
		out.type = 'string';
		warnings.push('a list with untyped items became `type: string, many: true` — `dt check` confirms the records agree');
	} else {
		const f = holder.format;
		out.type = holder.type === 'string' || holder.type === undefined
			? (f === 'markdown' ? 'markdown' : f === 'date' ? 'date' : f === 'date-time' ? 'datetime' : f === 'uri' ? 'url' : f === 'email' ? 'email' : 'string')
			: holder.type;
		if (!['string', 'markdown', 'date', 'datetime', 'url', 'email', 'integer', 'number', 'boolean'].includes(out.type)) {
			warnings.push(`type "${holder.type}" has no v2 equivalent — kept as written; fix it by hand`);
		}
	}
	if (required) out.required = true;
	if (many) out.many = true;
	for (const k of PASS) {
		const v = k === 'title' || k === 'description' || k === 'default' || k === 'examples' || k === 'minItems' || k === 'maxItems' ? p[k] : (holder[k] ?? p[k]);
		if (v !== undefined) out[k] = v;
	}
	const enumv = holder.enum ?? p.enum;
	if (enumv !== undefined) {
		const choices = holder['x-choices'] ?? p['x-choices'];
		out.enum = choices && typeof choices === 'object' ? Object.fromEntries(enumv.map((v) => [v, choices[v] ?? {}])) : enumv;
	}
	const pick = (k) => holder[k] ?? p[k];
	if (pick('x-unique') === true) out.unique = true;
	if (pick('x-on-delete') !== undefined) out.on_delete = pick('x-on-delete');
	// the body is prose — a v1 body declared as a bare string is the same text after the frontmatter
	if (pick('x-body') === true) { out.body = true; out.type = 'markdown'; }
	if (pick('x-sensitive') === true) out.sensitive = true;
	const inverseOf = pick('x-inverse-of');
	if (inverseOf !== undefined) out.mirror_of = String(inverseOf).slice(String(inverseOf).lastIndexOf('.') + 1);
	const tt = holder['x-title-template'];
	if (tt !== undefined) {
		if (out.type === 'object' && many) out.item_title = tt;
		else warnings.push('x-title-template on a reference is dropped — a reference is labelled by its target\'s record_title');
	}
	if (pick('x-display') !== undefined) warnings.push('x-display is dropped — a reference is labelled by its target\'s record_title');
	let fold;
	const inv = pick('x-inverse');
	if (inv !== undefined) {
		// the object form names the mirror `field` — compile's own reading (materializeRelations)
		const name = typeof inv === 'object' ? inv.field : inv;
		const description = pick('x-inverse-description') ?? (typeof inv === 'object' ? inv.description : undefined);
		fold = { name, description, unique: out.unique === true };
	}
	return { field: Object.fromEntries(Object.keys(out).sort((a, b) => rank(FIELD_ORDER, a) - rank(FIELD_ORDER, b)).map((k) => [k, out[k]])), fold, warnings };
}

/**
 * Convert one collection descriptor's TEXT. Returns the new text (null when it was already v2),
 * the relations declared on the owner that need a mirror field on their target, and warnings.
 * @param {string} text
 * @param {{ bareName?: string }} [ctx]   the name without its namespace, for the suffix default
 */
export function convertCollection(text, ctx = {}) {
	const doc = parseDocument(text, { keepSourceTokens: false });
	const top = doc.contents;
	if (!isMap(top)) return { text: null, folds: [], warnings: ['not a mapping — left alone'] };
	const v1 = top.toJSON();
	if ('fields' in v1) return { text: null, folds: [], warnings: [] };
	const warnings = [];
	const folds = [];
	const value = {};
	const renamed = {};
	for (const k of ['name', 'title', 'singular', 'description', 'use_when', 'sensitive']) if (v1[k] !== undefined) value[k] = v1[k];
	if (v1.title_template !== undefined) { value.record_title = v1.title_template; renamed.record_title = 'title_template'; }
	if (v1.group === 'system') { value.internal = true; renamed.internal = 'group'; }
	// storage
	{
		const s = v1.storage ?? {};
		const st = {};
		if (s.path !== undefined) st.path = s.path;
		if (s.codec !== undefined) st.format = s.codec === 'file' ? 'binary' : s.codec;
		if (s.shape !== undefined && s.shape !== 'file') st.shape = s.shape;
		if (s.entry !== undefined) st.entry = s.entry;
		const bare = ctx.bareName ?? String(v1.name ?? '').split('/').pop();
		const onDisk = s.suffix ?? v1Suffix(bare);
		if (onDisk !== singular(bare)) st.suffix = onDisk;
		if (s.under) st.under = { parent: s.under.field, subfolder: s.under.path };
		if (s.max_bytes !== undefined) st.max_bytes = s.max_bytes;
		if (s.extensions !== undefined) st.accept = s.extensions;
		if (Object.keys(st).length) value.storage = st;
	}
	if (v1.id) { value.ids = { ...(v1.id.generate !== undefined && { from: v1.id.generate }), ...(v1.id.pattern !== undefined && { pattern: v1.id.pattern }) }; renamed.ids = 'id'; }
	if (v1.templates) { value.mixins = v1.templates.map((t) => String(t).replace(/^collection-templates\//, '')); renamed.mixins = 'templates'; }
	if (v1.extends) { value.overlay = true; renamed.overlay = 'extends'; }
	// fields — the properties map node is RE-KEYED, so every comment above a property travels with it
	const schemaPair = pairOf(top, 'schema');
	const propsNode = schemaPair && isMap(schemaPair.value) ? pairOf(schemaPair.value, 'properties')?.value : null;
	const required = new Set(v1.schema?.required ?? []);
	const fields = {};
	let stats = { fields: 0, enums: 0 };
	for (const [k, p] of Object.entries(v1.schema?.properties ?? {})) {
		const { field, fold, warnings: w } = convertField(p, { required: required.has(k) });
		for (const x of w) warnings.push(`${k}: ${x}`);
		if (fold) folds.push({ field: k, target: field.type, many: field.many === true, ...fold });
		if (field.enum && !Array.isArray(field.enum)) stats.enums++;
		fields[k] = field;
		stats.fields++;
	}
	if (v1.sort_field !== undefined && fields[v1.sort_field]) {
		if (['string'].includes(fields[v1.sort_field].type)) fields[v1.sort_field].type = 'position';
		else (value.display ??= {}).list = { ...(value.display?.list ?? {}), sort: v1.sort_field };
	}
	value.fields = fields;
	if (v1.schema?.allOf) value.constraints = v1.schema.allOf;
	// display
	const nav = {};
	if (v1.icon !== undefined) nav.icon = v1.icon;
	if (v1.order !== undefined) nav.order = v1.order;
	if (v1.group !== undefined && v1.group !== 'system') nav.section = v1.group;
	const list = { ...(value.display?.list ?? {}) };
	if (v1.list_fields !== undefined) list.columns = v1.list_fields.map((c) => (c === 'last-modified' ? 'last_modified' : c));
	if (Object.keys(nav).length || Object.keys(list).length) value.display = { ...(Object.keys(nav).length && { nav }), ...(Object.keys(list).length && { list }) };
	// rewrite in place: `fields` takes over the `schema` pair's position and comments
	if (schemaPair) {
		schemaPair.key = doc.createNode('fields');
		if (propsNode) {
			schemaPair.value = propsNode;
			for (const pair of propsNode.items) {
				const k = keyOf(pair);
				if (!fields[k]) continue;
				if (isMap(pair.value)) rewriteMap(doc, pair.value, fields[k], FIELD_ORDER, { mirror_of: 'x-inverse-of', body: 'x-body', unique: 'x-unique', on_delete: 'x-on-delete', sensitive: 'x-sensitive', fields: 'properties' });
				else pair.value = doc.createNode(fields[k]);
			}
		} else schemaPair.value = doc.createNode(fields);
	}
	// every other top-level key, in canonical order; anything v1-only is dropped
	const keep = top.items.find((p) => keyOf(p) === 'fields');
	const rest = { ...value };
	delete rest.fields;
	rewriteMap(doc, top, { ...rest, fields: '__KEEP__' }, V2_ORDER, renamed);
	const at = top.items.findIndex((p) => keyOf(p) === 'fields');
	if (keep) top.items[at] = keep;
	else top.items[at] = doc.createPair('fields', fields);
	return { text: doc.toString(STRINGIFY), folds, warnings, stats };
}

/** A v1 collection-template's TEXT → the text of the equivalent mixin. */
export function convertTemplate(text, id) {
	const v1 = parseDocument(text).toJSON() ?? {};
	const t = v1.template ?? {};
	const req = new Set(t.schema?.required ?? []);
	const mixin = { name: id, ...(v1.description !== undefined && { description: v1.description }) };
	if (t.storage) {
		const s = t.storage;
		const st = {};
		if (s.path !== undefined) st.path = s.path;
		if (s.codec !== undefined) st.format = s.codec === 'file' ? 'binary' : s.codec;
		if (s.shape !== undefined && s.shape !== 'file') st.shape = s.shape;
		if (Object.keys(st).length) mixin.storage = st;
	}
	if (t.id) mixin.ids = { ...(t.id.generate !== undefined && { from: t.id.generate }), ...(t.id.pattern !== undefined && { pattern: t.id.pattern }) };
	mixin.fields = Object.fromEntries(Object.entries(t.schema?.properties ?? {}).map(([k, p]) => [k, convertField(p, { required: req.has(k) }).field]));
	if (t.list_fields) mixin.display = { list: { columns: t.list_fields.map((c) => (c === 'last-modified' ? 'last_modified' : c)) } };
	const doc = parseDocument(text);
	const out = parseDocument('{}');
	out.contents = out.createNode(mixin);
	out.commentBefore = doc.commentBefore;
	return out.toString(STRINGIFY);
}

/** Insert a mirror field into a v2 descriptor's TEXT, before its body field. No-op when present. */
export function addMirrorField(text, name, def) {
	const doc = parseDocument(text);
	const fields = doc.contents && pairOf(doc.contents, 'fields')?.value;
	if (!isMap(fields)) return { text, added: false };
	if (pairOf(fields, name)) return { text, added: false };
	const pair = doc.createPair(name, def);
	const bodyAt = fields.items.findIndex((p) => isMap(p.value) && toJS(p.value)?.body === true);
	if (bodyAt === -1) fields.items.push(pair);
	else fields.items.splice(bodyAt, 0, pair);
	fields.flow = false; // block style is canonical; a fresh overlay starts as `fields: {}`
	return { text: doc.toString(STRINGIFY), added: true };
}

// ---- the CLI ------------------------------------------------------------------------------------

function* walk(dir) {
	if (!fs.existsSync(dir)) return;
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) yield* walk(p);
		else yield p;
	}
}

/** Every source root a workspace AUTHORS: its modules, and the root itself for the classic layout. */
function sourceRoots(root) {
	const roots = [];
	const mods = path.join(root, 'modules');
	if (fs.existsSync(mods)) for (const e of fs.readdirSync(mods, { withFileTypes: true })) if (e.isDirectory()) roots.push(path.join(mods, e.name));
	roots.push(root);
	return roots;
}

export function migrate(root, { dryRun = false, log = console.log } = {}) {
	const plan = { descriptors: 0, fields: 0, folded: 0, enums: 0, mixins: 0, warnings: [], unfolded: [] };
	const texts = new Map(); // file -> new text
	const byName = new Map(); // collection name -> file of its BASE descriptor
	const moduleOf = new Map(); // descriptor file -> the module root it sits in
	for (const r of sourceRoots(root)) {
		for (const file of walk(path.join(r, 'collections'))) {
			if (!file.endsWith('.collection.yaml')) continue;
			const text = fs.readFileSync(file, 'utf8');
			const parsed = parseDocument(text);
			if (parsed.errors.length) throw new Error(`${path.relative(root, file)}: ${parsed.errors[0].message.split('\n')[0]}`);
			const name = parsed.toJSON()?.name;
			let res;
			try { res = convertCollection(text, { bareName: String(name ?? '').split('/').pop() }); } catch (e) { throw new Error(`${path.relative(root, file)}: ${e.message}`); }
			for (const w of res.warnings) plan.warnings.push(`${path.relative(root, file)}: ${w}`);
			moduleOf.set(file, r);
			if (name && !('overlay' in (parsed.toJSON() ?? {})) && !('extends' in (parsed.toJSON() ?? {}))) byName.set(name, file);
			if (res.text === null) { texts.set(file, text); continue; }
			texts.set(file, res.text);
			plan.descriptors++;
			plan.fields += res.stats.fields;
			plan.enums += res.stats.enums;
			for (const f of res.folds) {
				// the mirror's type is the OWNER collection, its cardinality the inverse of the owner's
				f.owner = name;
				f.ownerRoot = r;
				(plan._folds ??= []).push(f);
			}
		}
		for (const file of walk(path.join(r, 'collection-templates'))) {
			if (!file.endsWith('.collection-template.yaml')) continue;
			const id = path.basename(file).replace(/\.collection-template\.yaml$/, '');
			const dest = path.join(r, 'mixins', `${id}.mixin.yaml`);
			try { texts.set(dest, convertTemplate(fs.readFileSync(file, 'utf8'), id)); } catch (e) { throw new Error(`${path.relative(root, file)}: ${e.message}`); }
			texts.set(file, null); // removed
			plan.mixins++;
			// a module published from npm ships only what its `files` names — the mixins must travel
			const pkgFile = path.join(r, 'package.json');
			if (r !== root && fs.existsSync(pkgFile)) {
				const pkg = JSON.parse(texts.get(pkgFile) ?? fs.readFileSync(pkgFile, 'utf8'));
				if (Array.isArray(pkg.files) && !pkg.files.includes('mixins')) {
					pkg.files.push('mixins');
					texts.set(pkgFile, JSON.stringify(pkg, null, '\t') + '\n');
				}
			}
		}
	}
	for (const f of plan._folds ?? []) {
		const targets = Array.isArray(f.target) ? f.target : [f.target];
		for (const t of targets) {
			const file = byName.get(t);
			if (!file || texts.get(file) === undefined) { plan.unfolded.push(`${f.owner}.${f.field} → ${t}.${f.name}: the target's descriptor is not in this tree — add \`${f.name}: { type: ${f.owner}, ${f.unique && !f.many ? '' : 'many: true, '}mirror_of: ${f.field} }\` to it by hand`); continue; }
			const def = { type: f.owner, ...(!(f.unique && !f.many) && { many: true }), mirror_of: f.field, ...(f.description && { description: f.description }) };
			// A mirror on ANOTHER module's collection goes in an overlay in the OWNER's module — the
			// v1 stamp only happened while the owner was installed, and writing the field into the
			// target's own descriptor would make that module reference one it does not depend on.
			let dest = file;
			if (moduleOf.get(file) !== f.ownerRoot) {
				dest = path.join(f.ownerRoot, 'collections', `${t}.collection.yaml`);
				if (texts.get(dest) === undefined) texts.set(dest, fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : `name: ${t}\noverlay: true\nfields: {}\n`);
			}
			let text, added;
			try { ({ text, added } = addMirrorField(texts.get(dest), f.name, def)); } catch (e) { throw new Error(`${path.relative(root, dest)} (mirror ${f.name}): ${e.message}`); }
			if (added) { texts.set(dest, text); plan.folded++; }
		}
	}
	delete plan._folds;
	log(`${dryRun ? 'plan' : 'migrated'}: descriptors ${plan.descriptors} · fields ${plan.fields} · relations folded ${plan.folded} · enums merged ${plan.enums} · mixins ${plan.mixins}`);
	for (const w of plan.warnings) log(`⚠ ${w}`);
	for (const u of plan.unfolded) log(`⚠ ${u}`);
	if (!dryRun) {
		for (const [file, text] of texts) {
			if (text === null) { fs.rmSync(file); continue; }
			if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) continue;
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, text);
		}
	}
	return plan;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const at = args.indexOf('--root');
	const root = path.resolve(at >= 0 ? args[at + 1] : process.cwd());
	if (!fs.existsSync(path.join(root, 'package.json'))) {
		console.error(`✖ ${root} is not a workspace (no package.json)`);
		process.exit(2);
	}
	try {
		migrate(root, { dryRun: args.includes('--dry-run') });
	} catch (e) {
		console.error(`✖ ${e.message}`);
		process.exit(1);
	}
}
