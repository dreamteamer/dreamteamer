#!/usr/bin/env node
// migrate-descriptors-v2 — rewrite a workspace's v1 descriptor sources in descriptor format v2.
//
//   node node_modules/dreamteamer/scripts/migrate-descriptors-v2.mjs [--root <workspace>] [--dry-run]
//
// What it rewrites, under the workspace's own sources (`modules/*/` and a classic root layout):
//   - every `*.collection.yaml`, and every `*.collection-template.yaml`, which becomes `mixins/<id>.mixin.yaml`;
//   - every `*.ui-view.yaml`: `route`, `scope`, and the collection's own `display` block, layout option
//     keys renamed. A `default: true` view is not a view in v2 — the collection's `display` is its
//     default view — so it folds into that descriptor's `display.list` (a record-scope one into
//     `display.record`), or into an overlay when the collection belongs to another module, and the
//     view file is deleted;
//   - every `*.command-binding.yaml`: `scope`, `available_when`, `done_when`;
//   - the `dreamteamer` block of every package.json: snake_case keys, `peer_collections`, and
//     `disable` entries as `modules/<module>` or `<kind>/<id>`;
//   - the workspace's `dreamteamer.md`, which is named `DREAMTEAMER.md`, and its .gitignore, which
//     gains the generated harness files (it prints the `git rm --cached` for any git still tracks).
// Skill, agent and command frontmatter keeps its keys, so it is not touched.
// What it never touches: anything under `data/`, `node_modules/` or `git_modules/` (somebody else's
// sources — convert those in their own repo), and the bytes of any record.
//
// It edits the YAML DOCUMENT, not a re-dump, so a comment stays on the key it was written above, and
// it is idempotent: a source already in v2 is left alone. A relation declared on its OWNER (v1
// spelling A, `x-inverse`) is folded into the one v2 spelling — a `mirror_of` field on the target's
// descriptor — when the target is in the same tree; otherwise it is reported.
//
// The pure half (`convertCollection`, `convertTemplate`, `convertView`, `foldDisplay`,
// `convertBinding`, `convertPackage`, `addMirrorField`, `recordTitle`) is exported for the tests.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument, isMap, isSeq, isScalar, isPair, Scalar, visit } from 'yaml';
import { singular } from '../src/namespace.js';
import { MANIFEST_KEYS } from '../src/compile.js';
import { V2_KEYS as V2_ORDER } from '../src/descriptor-v2.js';
import { execFileSync } from 'node:child_process';

const STRINGIFY = { lineWidth: 0, flowCollectionPadding: false };
const FIELD_ORDER = ['type', 'title', 'required', 'many', 'default', 'enum', 'unique', 'mirror_of', 'on_delete', 'soft', 'sensitive', 'body', 'derived', 'virtual', 'deprecated', 'passthrough', 'fields', 'values', 'item_title', 'examples', 'pattern', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'const', 'display', 'description'];
const PASS = ['title', 'default', 'examples', 'pattern', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'const', 'description'];

/** Block style is canonical: a flow MAPPING is accepted on input and never written (a comma ends a
 *  flow value). Flow sequences of scalars stay as written. */
function toText(doc) {
	visit(doc, { Map(_, n) { if (n.items.length) n.flow = false; } });
	return doc.toString(STRINGIFY);
}

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
 * A record title whose first token is not a string field cannot be what `dt add <c> "<title>"`
 * fills, and v2 refuses it. Move the first string token to the front, keeping what preceded it as
 * the separator; with no string token at all, return null (the caller drops the key).
 * @param {string} tpl
 * @param {Record<string, string>} types   field name → its v2 type
 */
export function recordTitle(tpl, types) {
	const isText = (f) => types[f] === 'string' || types[f] === 'markdown';
	const parts = [...String(tpl).matchAll(/\{\{\s*([A-Za-z_][\w-]*)[^}]*\}\}/g)];
	if (!parts.length) return tpl;
	const first = parts[0][1];
	// a built-in or a field this converter cannot see the type of is left as written
	if (isText(first) || !(first in types)) return tpl;
	const at = parts.findIndex((m) => isText(m[1]));
	if (at === -1) return null;
	const token = parts[at];
	const prev = parts[at - 1];
	const sep = tpl.slice(prev.index + prev[0].length, token.index) || ' ';
	const rest = (tpl.slice(0, prev.index + prev[0].length) + tpl.slice(token.index + token[0].length)).trim();
	return `${token[0]}${sep}${rest}`;
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
	// a SOFT reference must target a named collection while a missing record is tolerated — `soft: true`.
	// One kind stays a plain string: a soft reference into `collections`, whose value names a
	// collection (a peer that may not be installed), not a record of one
	const soft = holder['x-reference-soft'] === true;
	const ref = soft && holder['x-reference'] === 'collections' ? undefined : holder['x-reference'];
	if (ref !== undefined) {
		out.type = ref === '*' ? 'reference' : ref;
		if (soft) out.soft = true;
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
	// v1 let a descriptor redeclare a template's field; v2 has one source per field. The same shape
	// is the mixin's field, so the redeclaration goes (its own description is printed, not lost); a
	// different shape is the author's call
	const shape = (f) => JSON.stringify(Object.fromEntries(Object.entries(f ?? {}).filter(([k]) => k !== 'description' && k !== 'title').sort(([a], [b]) => a.localeCompare(b))));
	for (const [k, { mixin, field: mf }] of Object.entries(ctx.mixinFieldDefs ?? {})) {
		if (!fields[k]) continue;
		if (shape(fields[k]) !== shape(mf)) { warnings.push(`${k}: also declared by mixin ${mixin} with a different shape — compile refuses a field from two sources; rename this one, or drop it and adjust the mixin`); continue; }
		if (fields[k].description !== undefined && fields[k].description !== mf.description) warnings.push(`${k}: also declared by mixin ${mixin} — dropped here, so its description is the mixin's; this collection's was: "${fields[k].description}"`);
		delete fields[k];
		stats.fields--;
	}
	if (v1.sort_field !== undefined && fields[v1.sort_field]) {
		if (['string'].includes(fields[v1.sort_field].type)) fields[v1.sort_field].type = 'position';
		else (value.display ??= {}).list = { ...(value.display?.list ?? {}), sort: v1.sort_field };
	}
	value.fields = fields;
	if (value.record_title !== undefined) {
		const types = { ...(ctx.mixinFields ?? {}), ...Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, f.type])) };
		const fixed = recordTitle(value.record_title, types);
		if (fixed === null) {
			warnings.push(`record_title "${value.record_title}" names no string field to open with — dropped, so the default (title · name · subject) applies`);
			delete value.record_title;
		} else value.record_title = fixed;
	}
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
			propsNode.items = propsNode.items.filter((pair) => fields[keyOf(pair)] !== undefined);
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
	return { text: toText(doc), folds, warnings, stats };
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
	return toText(out);
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
	return { text: toText(doc), added: true };
}

// ---- ui-views and command-bindings ----------------------------------------------------------------

const VIEW_ORDER = ['name', 'title', 'description', 'route', 'scope', 'collection', 'filter', 'display'];
const SCOPES = { list: 'collection', item: 'record', page: 'page' };
/** Layout option keys whose name changes: a field option is named for the role the field plays, a
 *  template option for what it labels. `template` labels a card, or a bar on a gantt. */
const OPTION_KEYS = {
	color_by_field: 'color_by', group_rows_by_field: 'group_by', group_columns_by_field: 'lanes_by',
	start_field: 'start', end_field: 'end', lat_field: 'lat', lng_field: 'lng',
	group_template: 'group_title', group_summary_template: 'group_summary',
};
const optionKey = (k, layout) => (k === 'template' ? (layout === 'gantt' ? 'bar_title' : 'card_title') : OPTION_KEYS[k] ?? (/^[a-z][a-z0-9_]*_field$/.test(k) ? k.replace(/_field$/, '') : k));
const injected = (v) => (typeof v === 'string' ? v.replace(/^(-?)last-modified$/, '$1last_modified') : v);

const scalarKey = (pair, k) => { if (isScalar(pair.key)) pair.key.value = k; else pair.key = new Scalar(k); return pair; };

/**
 * One v1 ui-view's TEXT → v2. Returns null when it is already v2. A `default: true` view comes back
 * as `fold` — the display block to merge into its collection's descriptor — and the caller deletes
 * the file; a default view that also filters cannot be a collection's display, and is converted as a
 * named view instead, with a warning.
 * @returns {null | { text?: string, fold?: { collection, block, value, nav, comment }, warnings: string[], options: number }}
 */
export function convertView(text) {
	const doc = parseDocument(text);
	const top = doc.contents;
	if (!isMap(top)) return null;
	const v1 = top.toJSON() ?? {};
	if ('route' in v1 || 'scope' in v1 || 'display' in v1) return null;
	const warnings = [];
	const scope = SCOPES[v1.target] ?? v1.target;
	const block = scope === 'record' ? 'record' : 'list';
	const take = (k) => { const p = pairOf(top, k); if (p) top.items.splice(top.items.indexOf(p), 1); return p; };
	const defaultPair = take('default');
	const fold = v1.default === true && v1.filter === undefined;
	if (v1.default === true && !fold) warnings.push('a default view with a filter cannot be its collection\'s display — converted as a named view');
	// the display sub-block: layout, columns and sort, then the remaining options with their keys renamed
	const sub = doc.createNode({});
	const layoutPair = take('layout');
	const layout = v1.layout;
	if (layoutPair && !(fold && layout === (block === 'list' ? 'table' : 'page'))) sub.items.push(layoutPair);
	const optionsPair = take('options');
	let renamedOptions = 0;
	if (optionsPair && isMap(optionsPair.value)) {
		const opts = optionsPair.value;
		// a comment above the first option belongs to that option, which may be about to move
		if (opts.commentBefore && opts.items[0]) { opts.items[0].key.commentBefore = [opts.commentBefore, opts.items[0].key.commentBefore].filter(Boolean).join('\n'); opts.commentBefore = undefined; }
		for (const k of block === 'list' ? ['columns', 'sort'] : []) {
			const p = pairOf(opts, k);
			if (!p) continue;
			opts.items.splice(opts.items.indexOf(p), 1);
			if (k === 'sort' && isScalar(p.value)) p.value.value = injected(p.value.value);
			if (k === 'columns' && isSeq(p.value)) for (const c of p.value.items) if (isScalar(c)) c.value = injected(c.value);
			sub.items.push(p);
		}
		for (const p of opts.items) {
			const k = keyOf(p);
			const to = optionKey(k, layout);
			if (to !== k) { scalarKey(p, to); renamedOptions++; }
			if (isScalar(p.value) && to !== k && /_field$/.test(k)) p.value.value = injected(p.value.value);
		}
		opts.flow = false;
		if (opts.items.length) sub.items.push(optionsPair);
	}
	const navPair = take('nav');
	if (navPair && isMap(navPair.value)) {
		const label = pairOf(navPair.value, 'label');
		if (label) scalarKey(label, 'title');
		navPair.value.flow = false;
	}
	if (fold) {
		const nav = toJS(navPair?.value) ?? {};
		if (nav.title !== undefined) warnings.push(`nav.label "${nav.title}" is dropped — a collection's nav entry reads its \`title\``);
		// the view's header, and any comment on a key that does not survive, reads above the folded block
		const comment = [doc.commentBefore, ...top.items.map((p) => p.key?.commentBefore), defaultPair?.key?.commentBefore].filter(Boolean).join('\n') || undefined;
		return {
			fold: { collection: String(v1.collection ?? '').replace(/^collections\//, ''), block, node: sub, nav: { ...(nav.icon !== undefined && { icon: nav.icon }), ...(nav.order !== undefined && { order: nav.order }) }, comment },
			warnings, options: renamedOptions,
		};
	}
	const pathPair = pairOf(top, 'path');
	if (pathPair) scalarKey(pathPair, 'route');
	const targetPair = pairOf(top, 'target');
	if (targetPair) { scalarKey(targetPair, 'scope'); if (isScalar(targetPair.value)) targetPair.value.value = scope; }
	const display = doc.createNode({});
	if (navPair) display.items.push(navPair);
	if (sub.items.length) display.items.push(doc.createPair(block, sub));
	if (display.items.length) {
		const pair = doc.createPair('display', display);
		// the moved pairs carry their own comments; one above a dropped `default: false` reads on the block
		if (defaultPair?.key?.commentBefore) pair.key.commentBefore = defaultPair.key.commentBefore;
		top.items.push(pair);
	}
	top.items.sort((a, b) => rank(VIEW_ORDER, keyOf(a)) - rank(VIEW_ORDER, keyOf(b)));
	return { text: toText(doc), warnings, options: renamedOptions };
}

/** Merge a folded default view into a v2 descriptor's TEXT: its sub-block keys win, and nav keys
 *  fill only where the descriptor has none. The view's pairs move whole, so a comment above a key
 *  stays above it, and the view's own header lands above the block. */
export function foldDisplay(text, { block, node, nav = {}, comment }) {
	const doc = parseDocument(text);
	const top = doc.contents;
	let display = pairOf(top, 'display');
	if (!display) { display = doc.createPair('display', {}); top.items.push(display); }
	if (!isMap(display.value)) display.value = doc.createNode({});
	display.value.flow = false;
	const ensure = (k) => {
		let p = pairOf(display.value, k);
		if (!p) { p = doc.createPair(k, {}); display.value.items.push(p); }
		if (!isMap(p.value)) p.value = doc.createNode({});
		p.value.flow = false;
		return p;
	};
	if (node?.items?.length) {
		const sub = ensure(block);
		for (const p of node.items) {
			const old = pairOf(sub.value, keyOf(p));
			if (old) sub.value.items.splice(sub.value.items.indexOf(old), 1, p);
			else sub.value.items.push(p);
		}
		if (comment) sub.key.commentBefore = [sub.key.commentBefore, comment].filter(Boolean).join('\n');
	}
	const navKeys = Object.entries(nav).filter(([k]) => !pairOf(pairOf(display.value, 'nav')?.value, k));
	if (navKeys.length) { const n = ensure('nav'); for (const [k, v] of navKeys) n.value.items.push(doc.createPair(k, v)); }
	display.value.items.sort((a, b) => rank(['nav', 'list', 'record', 'form'], keyOf(a)) - rank(['nav', 'list', 'record', 'form'], keyOf(b)));
	return toText(doc);
}

const BINDING_KEYS = { target: 'scope', 'can-enter': 'available_when', 'can-exit': 'done_when' };
/** One v1 command-binding's TEXT → v2, keys renamed in place so every comment stays put. Null when v2. */
export function convertBinding(text) {
	const doc = parseDocument(text);
	if (!isMap(doc.contents)) return null;
	const hits = doc.contents.items.filter((p) => BINDING_KEYS[keyOf(p)]);
	if (!hits.length) return null;
	for (const p of hits) scalarKey(p, BINDING_KEYS[keyOf(p)]);
	return toText(doc);
}

// ---- package.json `dreamteamer` blocks --------------------------------------------------------------

/**
 * A package.json's TEXT with its `dreamteamer` block in v2: snake_case keys, `peer_collections`, and
 * `disable` in the record grammar — a whole module (a bare name or `@scope/name`) as
 * `modules/<it>`, a `<module>/<entity>` as `<kind>/<entity>`. `kindsOf(module, entity)` answers
 * which kinds a module ships that entity in — [] when it does not, null when the module is unknown.
 * A key the engine does not read is reported, since compile refuses it. Null text when nothing changes.
 */
export function convertPackage(text, kindsOf) {
	const pkg = JSON.parse(text);
	const block = pkg.dreamteamer;
	if (!block || typeof block !== 'object') return { text: null, warnings: [] };
	const warnings = [];
	const out = {};
	for (const [k, v] of Object.entries(block)) {
		const key = k === 'peerDependencies' || k === 'peer-dependencies' ? 'peer_collections' : k.replace(/-/g, '_');
		out[key] = key === 'peer_collections' && Array.isArray(v) ? v.map((c) => String(c).replace(/^collections\//, '')) : v;
	}
	for (const k of Object.keys(out)) if (!MANIFEST_KEYS.includes(k)) warnings.push(`dreamteamer.${k} is not a key the engine reads, and compile refuses it — the keys are ${MANIFEST_KEYS.join(' · ')}`);
	if (Array.isArray(out.disable)) {
		out.disable = out.disable.flatMap((d) => {
			if (typeof d !== 'string') return [d];
			if (!d.includes('/') || /^@[^/]+\/[^/]+$/.test(d)) return [`modules/${d}`];
			const segs = d.split('/');
			const mod = d.startsWith('@') ? segs.slice(0, 2).join('/') : segs[0];
			const id = segs.slice(d.startsWith('@') ? 2 : 1).join('/');
			const kinds = kindsOf(mod, id);
			if (kinds === null) return [d]; // not a module: already `<kind>/<id>`, or a name this tree cannot see
			if (!kinds.length) { warnings.push(`disable "${d}": module ${mod} ships no "${id}" — left as written`); return [d]; }
			return kinds.map((k) => `${k}/${id}`);
		});
	}
	pkg.dreamteamer = out;
	const indent = /^[ \t]+(?=")/m.exec(text)?.[0] ?? '\t';
	const next = JSON.stringify(pkg, null, indent) + (text.endsWith('\n') ? '\n' : '');
	return { text: next === text ? null : next, warnings };
}

/** The kinds a module root ships one entity id in — the folders compile reads, either layout. */
function entityKinds(moduleRoot, id) {
	const kinds = [];
	for (const kind of ['collections', 'skills', 'agents', 'commands', 'command-bindings', 'ui-views', 'mixins', 'collection-templates']) {
		for (const dir of [path.join(moduleRoot, kind), path.join(moduleRoot, 'system', kind)]) {
			if (!fs.existsSync(dir)) continue;
			const hit = kind === 'skills'
				? fs.existsSync(path.join(dir, id))
				: [...walk(dir)].some((f) => path.relative(dir, f).split(path.sep).join('/').replace(/\.[^.]+\.(yaml|md|json)$/, '') === id);
			if (hit) { kinds.push(kind === 'collection-templates' ? 'mixins' : kind); break; }
		}
	}
	return [...new Set(kinds)];
}

/** Every module this workspace can see, by package name → the roots carrying that name (the
 *  workspace's own package may share its module's name). */
function moduleRootsByName(root) {
	const out = new Map();
	const add = (dir) => {
		try { const name = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name; if (name) out.set(name, [...(out.get(name) ?? []), dir]); } catch { /* not a module */ }
	};
	for (const base of ['modules', 'git_modules']) {
		const at = path.join(root, base);
		if (!fs.existsSync(at)) continue;
		for (const e of fs.readdirSync(at, { withFileTypes: true })) {
			if (!e.isDirectory() && !e.isSymbolicLink()) continue;
			if (e.name.startsWith('@')) for (const s of fs.readdirSync(path.join(at, e.name))) add(path.join(at, e.name, s));
			else add(path.join(at, e.name));
		}
	}
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
		for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) add(path.join(root, 'node_modules', dep));
	} catch { /* no package.json is caught by the CLI */ }
	add(root);
	return out;
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
	const plan = { descriptors: 0, fields: 0, folded: 0, enums: 0, mixins: 0, viewsFolded: 0, viewsConverted: 0, bindings: 0, packages: 0, instructions: 0, ignored: 0, warnings: [], unfolded: [] };
	const texts = new Map(); // file -> new text (null: removed)
	const byName = new Map(); // collection name -> file of its BASE descriptor
	const moduleOf = new Map(); // descriptor file -> the module root it sits in
	const roots = sourceRoots(root);
	const at = (file) => path.relative(root, file);
	const current = (file) => (texts.has(file) ? texts.get(file) : fs.readFileSync(file, 'utf8'));
	// templates first: a mixin's field types are what a converted record_title may open with
	const mixinTypes = new Map(); // mixin id -> { field: type }
	const mixinDefs = new Map(); // mixin id -> { field: its v2 definition }
	for (const r of roots) {
		for (const file of walk(path.join(r, 'collection-templates'))) {
			if (!file.endsWith('.collection-template.yaml')) continue;
			const id = path.basename(file).replace(/\.collection-template\.yaml$/, '');
			const dest = path.join(r, 'mixins', `${id}.mixin.yaml`);
			let text;
			try { text = convertTemplate(fs.readFileSync(file, 'utf8'), id); } catch (e) { throw new Error(`${at(file)}: ${e.message}`); }
			texts.set(dest, text);
			texts.set(file, null);
			mixinTypes.set(id, Object.fromEntries(Object.entries(parseDocument(text).toJSON()?.fields ?? {}).map(([k, f]) => [k, f?.type])));
			mixinDefs.set(id, parseDocument(text).toJSON()?.fields ?? {});
			plan.mixins++;
			// a module published from npm ships only what its `files` names — the mixins must travel
			const pkgFile = path.join(r, 'package.json');
			if (r !== root && fs.existsSync(pkgFile)) {
				const pkg = JSON.parse(current(pkgFile));
				if (Array.isArray(pkg.files) && !pkg.files.includes('mixins')) {
					pkg.files.push('mixins');
					texts.set(pkgFile, JSON.stringify(pkg, null, '\t') + '\n');
				}
			}
		}
	}
	for (const r of roots) {
		for (const file of walk(path.join(r, 'collections'))) {
			if (!file.endsWith('.collection.yaml')) continue;
			const text = fs.readFileSync(file, 'utf8');
			const parsed = parseDocument(text);
			if (parsed.errors.length) throw new Error(`${at(file)}: ${parsed.errors[0].message.split('\n')[0]}`);
			const v1 = parsed.toJSON() ?? {};
			const name = v1.name;
			const ids = (Array.isArray(v1.templates) ? v1.templates : []).map((t) => String(t).replace(/^collection-templates\//, ''));
			const mixinFields = Object.assign({}, ...ids.map((t) => mixinTypes.get(t) ?? {}));
			const mixinFieldDefs = Object.assign({}, ...ids.map((t) => Object.fromEntries(Object.entries(mixinDefs.get(t) ?? {}).map(([k, f]) => [k, { mixin: t, field: f }]))));
			let res;
			try { res = convertCollection(text, { bareName: String(name ?? '').split('/').pop(), mixinFields, mixinFieldDefs }); } catch (e) { throw new Error(`${at(file)}: ${e.message}`); }
			for (const w of res.warnings) plan.warnings.push(`${at(file)}: ${w}`);
			moduleOf.set(file, r);
			if (name && !('overlay' in v1) && !('extends' in v1)) byName.set(name, file);
			if (res.text === null) continue;
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
	}
	for (const f of plan._folds ?? []) {
		const targets = Array.isArray(f.target) ? f.target : [f.target];
		for (const t of targets) {
			const file = byName.get(t);
			if (!file) { plan.unfolded.push(`${f.owner}.${f.field} → ${t}.${f.name}: the target's descriptor is not in this tree — add \`${f.name}: { type: ${f.owner}, ${f.unique && !f.many ? '' : 'many: true, '}mirror_of: ${f.field} }\` to it by hand`); continue; }
			const def = { type: f.owner, ...(!(f.unique && !f.many) && { many: true }), mirror_of: f.field, ...(f.description && { description: f.description }) };
			// A mirror on ANOTHER module's collection goes in an overlay in the OWNER's module — the
			// v1 stamp only happened while the owner was installed, and writing the field into the
			// target's own descriptor would make that module reference one it does not depend on.
			const dest = moduleOf.get(file) === f.ownerRoot ? file : overlayFile(f.ownerRoot, t, texts);
			let text, added;
			try { ({ text, added } = addMirrorField(current(dest), f.name, def)); } catch (e) { throw new Error(`${at(dest)} (mirror ${f.name}): ${e.message}`); }
			if (added) { texts.set(dest, text); plan.folded++; }
		}
	}
	delete plan._folds;
	// ui-views: a default view folds into its collection's display; every other view is rewritten
	for (const r of roots) {
		for (const file of walk(path.join(r, 'ui-views'))) {
			if (!file.endsWith('.ui-view.yaml')) continue;
			let res;
			try { res = convertView(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${at(file)}: ${e.message}`); }
			if (!res) continue;
			for (const w of res.warnings) plan.warnings.push(`${at(file)}: ${w}`);
			if (!res.fold) { texts.set(file, res.text); plan.viewsConverted++; continue; }
			const { collection } = res.fold;
			const base = byName.get(collection);
			// the view's own module edits the collection it owns; any other module's collection takes an overlay
			const dest = base && moduleOf.get(base) === r ? base : overlayFile(r, collection, texts);
			if (dest !== base) {
				const owner = base ? packageName(moduleOf.get(base)) : null;
				const deps = (() => { try { return JSON.parse(current(path.join(r, 'package.json'))).dreamteamer?.dependencies ?? []; } catch { return []; } })();
				if (!(owner === null && ENGINE_COLLECTIONS.has(collection)) && (!owner || !deps.includes(owner))) plan.warnings.push(`${at(file)}: folded into an overlay of ${collection} (${at(dest)}) — an overlay needs ${owner ? `"${owner}"` : `the module that owns ${collection}`} in this module's \`dreamteamer.dependencies\``);
			}
			try { texts.set(dest, foldDisplay(current(dest), res.fold)); } catch (e) { throw new Error(`${at(dest)} (view ${path.basename(file)}): ${e.message}`); }
			texts.set(file, null);
			plan.viewsFolded++;
		}
		for (const file of walk(path.join(r, 'command-bindings'))) {
			if (!file.endsWith('.command-binding.yaml')) continue;
			const text = convertBinding(fs.readFileSync(file, 'utf8'));
			if (text === null) continue;
			texts.set(file, text);
			plan.bindings++;
		}
	}
	// package.json blocks: the workspace's and each module's own
	const modules = moduleRootsByName(root);
	const kindsOf = (mod, id) => (modules.has(mod) ? [...new Set(modules.get(mod).flatMap((dir) => entityKinds(dir, id)))] : null);
	for (const r of roots) {
		const file = path.join(r, 'package.json');
		if (!fs.existsSync(file)) continue;
		let res;
		try { res = convertPackage(current(file), kindsOf); } catch (e) { throw new Error(`${at(file)}: ${e.message}`); }
		for (const w of res.warnings) plan.warnings.push(`${at(file)}: ${w}`);
		if (res.text === null) continue;
		texts.set(file, res.text);
		plan.packages++;
	}
	// the hand-written instructions file is DREAMTEAMER.md; the generated harness files are build output
	const names = fs.readdirSync(root);
	const renameInstructions = names.includes('dreamteamer.md');
	if (renameInstructions && names.includes('DREAMTEAMER.md')) plan.warnings.push('dreamteamer.md and DREAMTEAMER.md both exist — merge them into DREAMTEAMER.md by hand');
	plan.instructions = renameInstructions && !names.includes('DREAMTEAMER.md') ? 1 : 0;
	const ignoreFile = path.join(root, '.gitignore');
	const ignoreText = fs.existsSync(ignoreFile) ? fs.readFileSync(ignoreFile, 'utf8') : '';
	const ignoreLines = new Set(ignoreText.split(/\r?\n/).map((l) => l.trim()));
	// a root harness file is compile's only when everything in it is a generated block; one with text
	// of its own outside the blocks is hand-written, stays tracked, and is named — ignoring it would
	// drop that text from every fresh clone
	const ownText = (f) => fs.readFileSync(path.join(root, f), 'utf8')
		.replace(/<!-- dreamteamer:(instructions:)?begin[^>]*-->[\s\S]*?<!-- dreamteamer:(instructions:)?end -->/g, '').trim();
	const handWritten = HARNESS_FILES.filter((f) => names.includes(f) && ownText(f) !== '');
	for (const f of handWritten) plan.warnings.push(`${f} carries text outside the generated block, so it stays tracked and is not ignored — move that text into DREAMTEAMER.md, then run this again to hand ${f} to compile`);
	const generated = HARNESS_FILES.filter((f) => !handWritten.includes(f));
	const toIgnore = generated.map((f) => `/${f}`).filter((l) => !ignoreLines.has(l));
	plan.ignored = toIgnore.length;
	log(`${dryRun ? 'plan' : 'migrated'}: descriptors ${plan.descriptors} · fields ${plan.fields} · relations folded ${plan.folded} · enums merged ${plan.enums} · mixins ${plan.mixins} · views folded ${plan.viewsFolded} · views converted ${plan.viewsConverted} · bindings converted ${plan.bindings} · packages ${plan.packages} · instructions renamed ${plan.instructions} · harness files ignored ${plan.ignored}`);
	for (const w of plan.warnings) log(`⚠ ${w}`);
	for (const u of plan.unfolded) log(`⚠ ${u}`);
	const tracked = trackedFiles(root, generated);
	if (tracked.length) log(`then stop tracking the generated harness files: git rm --cached ${tracked.join(' ')}`);
	if (!dryRun) {
		if (plan.instructions) {
			// through a temporary name: on a case-insensitive filesystem the two spellings are one path
			const tmp = path.join(root, `.dreamteamer.md.${process.pid}`);
			fs.renameSync(path.join(root, 'dreamteamer.md'), tmp);
			fs.renameSync(tmp, path.join(root, 'DREAMTEAMER.md'));
		}
		if (toIgnore.length) fs.writeFileSync(ignoreFile, `${ignoreText}${ignoreText && !ignoreText.endsWith('\n') ? '\n' : ''}# harness files compile generates\n${toIgnore.join('\n')}\n`);
		for (const [file, text] of texts) {
			if (text === null) {
				fs.rmSync(file, { force: true });
				// an emptied `collection-templates/` is a folder of a kind the engine no longer knows
				const dir = path.dirname(file);
				if (path.basename(dir) === 'collection-templates' && fs.existsSync(dir) && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
				continue;
			}
			if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) continue;
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, text);
		}
	}
	return plan;
}

const packageName = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name; } catch { return null; } };

/** The harness files compile writes at the workspace root. */
const HARNESS_FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'NOTEBOOKLM.md'];
/** The engine's own collections: any module may overlay one without declaring a dependency. */
const ENGINE_COLLECTIONS = (() => {
	try { return new Set(fs.readdirSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'collections')).filter((f) => f.endsWith('.collection.yaml')).map((f) => f.replace(/\.collection\.yaml$/, ''))); } catch { return new Set(); }
})();

/** Which of `files` git tracks in `root` — [] when it is not a repository or git is not there. */
function trackedFiles(root, files) {
	try { return execFileSync('git', ['ls-files', '--', ...files], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).split('\n').filter(Boolean); } catch { return []; }
}

/** The overlay of `collection` in module root `r` — its existing source, or a fresh one. */
function overlayFile(r, collection, texts) {
	const dest = path.join(r, 'collections', `${collection}.collection.yaml`);
	if (!texts.has(dest)) texts.set(dest, fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : `name: ${collection}\noverlay: true\nfields: {}\n`);
	return dest;
}

/** Is this file the program node was asked to run? Compared through realpaths, because the engine is
 *  often reached through a link (`git_modules/dreamteamer`, an npm link) and a plain resolve differs. */
function invokedDirectly() {
	try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) {
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
