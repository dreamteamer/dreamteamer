// The authored descriptor — validated, and merged with its mixins and overlays.
//
// A descriptor is recognised by its `fields` block. It is validated here (closed top-level keys, the
// storage, ids and display blocks, every template and every field name the descriptor mentions
// outside `fields`), and its mixins and overlays are merged into ONE authored descriptor that
// compile-collections.js resolves.
//
// Pure: no fs, no git. Errors are returned, never thrown, so compile attributes each to a file.
import { validateTemplate } from './template.js';

/** The top-level keys a v2 descriptor may carry, in canonical order. */
export const V2_KEYS = ['name', 'title', 'singular', 'record_title', 'description', 'use_when', 'internal', 'sensitive', 'storage', 'ids', 'mixins', 'overlay', 'fields', 'constraints', 'display'];

const STORAGE_KEYS = ['path', 'format', 'shape', 'entry', 'suffix', 'under', 'max_bytes', 'accept'];
const DISPLAY_BLOCKS = { nav: ['icon', 'order', 'section'], list: ['layout', 'columns', 'sort', 'options'], record: ['layout', 'subtitle', 'badge', 'color_by', 'options'], form: ['sections'] };

export const isV2 = (doc) => !!doc && typeof doc === 'object' && !Array.isArray(doc) && 'fields' in doc;

/** Shape errors that need no other descriptor: closed keys, v1 keys, storage, id, display layout. */
export function shapeErrors(doc) {
	const errors = [];
	for (const k of Object.keys(doc)) {
		if (V2_KEYS.includes(k)) continue;
		errors.push(`unknown key \`${k}\` — a descriptor's keys are ${V2_KEYS.join(' · ')}`);
	}
	if (doc.overlay !== undefined && doc.overlay !== true) errors.push('`overlay` is `true` or absent — the base is the one source of this collection without it');
	const s = doc.storage ?? {};
	for (const k of Object.keys(s)) {
		if (STORAGE_KEYS.includes(k)) continue;
		errors.push(`unknown key \`storage.${k}\` — storage keys are ${STORAGE_KEYS.join(' · ')}`);
	}
	if (s.format !== undefined && !['md', 'yaml', 'json', 'binary'].includes(s.format)) errors.push('`storage.format` is md · yaml · json · binary');
	if (s.shape !== undefined && !['file', 'folder'].includes(s.shape)) errors.push('`storage.shape` is file · folder');
	if (s.under !== undefined) {
		const u = s.under;
		if (!u || typeof u !== 'object') errors.push('`storage.under` is { parent, subfolder }');
		else {
			for (const k of Object.keys(u)) if (!['parent', 'subfolder', 'id'].includes(k)) errors.push(`unknown key \`storage.under.${k}\` — under takes parent · subfolder · id`);
			if (!u.parent || !u.subfolder) errors.push('`storage.under` needs both `parent` (a reference field of this collection) and `subfolder`');
			if (u.id !== undefined && !['independent', 'nested'].includes(u.id)) errors.push('`storage.under.id` is independent (the id survives a move) or nested (the id begins with the parent\'s)');
		}
	}
	if (doc.ids !== undefined) {
		for (const k of Object.keys(doc.ids)) if (!['from', 'pattern'].includes(k)) errors.push(`unknown key \`ids.${k}\` — ids takes from · pattern`);
	}
	if (doc.display !== undefined) {
		for (const [b, v] of Object.entries(doc.display)) {
			if (!DISPLAY_BLOCKS[b]) { errors.push(`unknown key \`display.${b}\` — display has ${Object.keys(DISPLAY_BLOCKS).join(' · ')}`); continue; }
			for (const k of Object.keys(v ?? {})) if (!DISPLAY_BLOCKS[b].includes(k)) errors.push(`unknown key \`display.${b}.${k}\` — ${b} has ${DISPLAY_BLOCKS[b].join(' · ')}`);
		}
	}
	if (doc.constraints !== undefined && !Array.isArray(doc.constraints)) errors.push('`constraints` is a list of JSON Schema combinators');
	return errors;
}

/**
 * Merge mixins into a descriptor, in list order. Fields go before the body field; `storage`, `ids`
 * and `display` apply key by key where the descriptor is silent; constraints concatenate. A field
 * name two sources both declare is an error naming both.
 * @param {object} doc
 * @param {Map<string, object>} mixins   id → mixin doc
 * @returns {{ doc: object, errors: string[], used: string[] }}
 */
export function mergeMixins(doc, mixins) {
	const errors = [];
	const used = [];
	const out = structuredClone(doc);
	const ids = doc.mixins ?? [];
	if (!Array.isArray(ids)) return { doc: out, errors: ['`mixins` is a list of mixin ids'], used };
	const owned = new Map(Object.keys(doc.fields ?? {}).map((f) => [f, 'the descriptor']));
	const added = {};
	const constraints = [...(doc.constraints ?? [])];
	for (const id of ids) {
		const m = mixins.get(id);
		if (!m) { errors.push(`mixin "${id}" does not exist (have: ${[...mixins.keys()].join(', ') || 'none'})`); continue; }
		used.push(id);
		for (const [f, v] of Object.entries(m.fields ?? {})) {
			if (owned.has(f)) { errors.push(`field "${f}" is declared by ${owned.get(f)} and by mixin "${id}" — one source per field`); continue; }
			owned.set(f, `mixin "${id}"`);
			added[f] = structuredClone(v);
		}
		for (const k of ['storage', 'ids']) if (m[k]) out[k] = { ...structuredClone(m[k]), ...(out[k] ?? {}) };
		if (m.display) {
			out.display ??= {};
			for (const [b, v] of Object.entries(m.display)) out.display[b] = { ...structuredClone(v), ...(out.display[b] ?? {}) };
		}
		constraints.push(...(m.constraints ?? []));
	}
	// fields: the descriptor's own, with the mixins' inserted before the body
	const own = Object.entries(out.fields ?? {});
	const bodyAt = own.findIndex(([, f]) => f?.body);
	const merged = bodyAt < 0 ? [...own, ...Object.entries(added)] : [...own.slice(0, bodyAt), ...Object.entries(added), ...own.slice(bodyAt)];
	out.fields = Object.fromEntries(merged);
	if (constraints.length) out.constraints = constraints;
	delete out.mixins;
	return { doc: out, errors, used };
}

/**
 * Field names a descriptor mentions outside `fields` must exist (rule 6). Templates are parsed with
 * the one grammar. Returns errors naming each position.
 */
export function nameErrors(doc) {
	const errors = [];
	const fields = doc.fields ?? {};
	const names = Object.keys(fields);
	const has = (f) => f === 'id' || f === 'created' || f === 'last_modified' || names.includes(f);
	const d = doc.display ?? {};
	for (const c of d.list?.columns ?? []) if (!has(c)) errors.push(`display.list.columns names "${c}", which is not a field`);
	if (d.list?.sort !== undefined && !has(String(d.list.sort).replace(/^-/, ''))) errors.push(`display.list.sort names "${d.list.sort}", which is not a field`);
	for (const k of ['badge', 'color_by']) if (d.record?.[k] !== undefined && !has(d.record[k])) errors.push(`display.record.${k} names "${d.record[k]}", which is not a field`);
	if (d.record?.color_by !== undefined && fields[d.record.color_by] && !fields[d.record.color_by].enum) errors.push(`display.record.color_by names "${d.record.color_by}", which has no enum to take colours from`);
	const sectioned = new Set();
	for (const [i, s] of (d.form?.sections ?? []).entries()) {
		if (!s?.title) errors.push(`display.form.sections[${i}] has no title`);
		for (const f of s?.fields ?? []) {
			if (!has(f)) errors.push(`display.form.sections "${s?.title ?? i}" names "${f}", which is not a field`);
			else if (fields[f]?.display?.hidden?.includes('form')) errors.push(`display.form.sections "${s?.title ?? i}" lists "${f}", which is hidden from the form`);
			if (sectioned.has(f)) errors.push(`display.form.sections lists "${f}" twice`);
			sectioned.add(f);
		}
	}
	const parent = doc.storage?.under?.parent;
	if (parent !== undefined && (!fields[parent] || fields[parent].many)) errors.push(`storage.under.parent names "${parent}", which is not a scalar reference field of this collection`);
	// templates
	if (doc.record_title !== undefined) {
		errors.push(...validateTemplate(doc.record_title, { position: 'record_title', fields: names }));
		const first = /\{\{\s*([A-Za-z_]\w*)/.exec(doc.record_title)?.[1];
		if (first && fields[first] && !['string', 'markdown'].includes(fields[first].type)) errors.push(`record_title opens with "${first}", a ${fields[first].type} field — its first token is what \`dt add <collection> "<title>"\` fills, so it must be a string field`);
	}
	if (d.record?.subtitle !== undefined) errors.push(...validateTemplate(d.record.subtitle, { position: 'display.record.subtitle', fields: names }));
	const from = doc.ids?.from;
	for (const t of Array.isArray(from) ? from : from === undefined ? [] : [from]) errors.push(...validateTemplate(t, { position: 'ids.from', fields: names, id: true }));
	for (const [f, v] of Object.entries(fields)) if (v?.item_title) errors.push(...validateTemplate(v.item_title, { position: `fields.${f}.item_title`, fields: Object.keys(v.fields ?? {}) }));
	return errors;
}

/** A field refined by an overlay: the overlay's keys win, `display` merged key by key. */
function refineField(f, by) {
	const out = { ...f, ...by };
	if (f?.display && by?.display) out.display = { ...f.display, ...by.display };
	return out;
}

/** A base and its overlays as ONE v2 descriptor: overlay fields inserted before the body,
 *  constraints concatenated, every other key overlay-wins key by key (display per sub-block). */
export function mergeOverlays(base, overlays) {
	const out = structuredClone(base);
	for (const o of overlays) {
		// a field already present — from the base OR an earlier overlay — is refined in place, key by key
		// (its `display` too); a new one goes in before the body field
		const own = Object.entries(out.fields ?? {}).map(([k, f]) => [k, k in (o.fields ?? {}) ? refineField(f, o.fields[k]) : f]);
		const bodyAt = own.findIndex(([, f]) => f?.body);
		const add = Object.entries(o.fields ?? {}).filter(([k]) => !(k in (out.fields ?? {})));
		out.fields = Object.fromEntries(bodyAt < 0 ? [...own, ...add] : [...own.slice(0, bodyAt), ...add, ...own.slice(bodyAt)]);
		if (o.constraints) out.constraints = [...(out.constraints ?? []), ...o.constraints];
		if (o.display) {
			out.display ??= {};
			for (const [b, v] of Object.entries(o.display)) out.display[b] = { ...(out.display[b] ?? {}), ...v };
		}
		for (const [k, v] of Object.entries(o)) if (!['name', 'overlay', 'fields', 'constraints', 'display', 'mixins'].includes(k)) out[k] = structuredClone(v);
	}
	delete out.overlay;
	return out;
}
