// Descriptor format v2 — the authored shape, validated and translated for compile.
//
// A v2 descriptor is recognised by its `fields` block. It is validated here (closed top-level keys,
// every v1 key refused with its v2 replacement named, templates and the field names a descriptor
// mentions checked against what it declares), mixins are merged in v2 space, and it is translated
// into the internal shape the rest of the engine reads today. The translation is the transition: as
// each consumer moves to `compiled.fields`, the internal shape loses a reader, and when it has none
// it is deleted. Nothing outside this file and compile.js knows a v2 source existed.
//
// Pure: no fs, no git. Errors are returned, never thrown, so compile attributes each to a file.
import { resolveFields, toJsonSchema, enumValues, enumChoices, referenceTargets } from './fields.js';
import { validateTemplate } from './template.js';

/** The top-level keys a v2 descriptor may carry, in canonical order. */
export const V2_KEYS = ['name', 'title', 'singular', 'record_title', 'description', 'use_when', 'internal', 'sensitive', 'storage', 'ids', 'mixins', 'overlay', 'fields', 'constraints', 'display'];

/** Every v1 key, and what replaces it — so a half-migrated file fails with the fix in the message. */
export const V1_REPLACEMENTS = {
	schema: '`fields`',
	// `id` is the RECORD's id everywhere else — a reference, a filter, `{{ id }}`, the injected field —
	// and a descriptor is itself a record, so the block that says how ids are made cannot share it
	id: '`ids` (from · pattern)',
	extends: '`overlay: true`',
	templates: '`mixins`',
	list_fields: '`display.list.columns`',
	sort_field: 'a field of `type: position`',
	title_template: '`record_title`',
	group: '`display.nav.section`, or `internal: true` for workspace plumbing',
	icon: '`display.nav.icon`',
	order: '`display.nav.order`',
	owner: 'nothing — the folder a descriptor sits in is its module',
	module: 'nothing — the folder a descriptor sits in is its module',
	overlays: 'nothing — compile writes `compiled.overlaid_by`',
	unresolved_peers: 'nothing — compile writes it',
};

// `suffix` stays authorable: its default is the bare singular, and existing records carry the suffix
// they were written with — six collections of one real workspace differ from their singular
const STORAGE_KEYS = ['path', 'format', 'shape', 'entry', 'suffix', 'under', 'max_bytes', 'accept'];
const STORAGE_V1 = { codec: '`format` (md · yaml · json · binary)', extensions: '`accept`', base: 'nothing — compile writes `compiled.runtime`', repo: 'nothing — compile writes `compiled.repo`' };
const DISPLAY_BLOCKS = { nav: ['icon', 'order', 'section'], list: ['layout', 'columns', 'sort', 'options'], record: ['layout', 'subtitle', 'badge', 'color_by'], form: ['sections'] };

export const isV2 = (doc) => !!doc && typeof doc === 'object' && !Array.isArray(doc) && 'fields' in doc;

/** Shape errors that need no other descriptor: closed keys, v1 keys, storage, id, display layout. */
export function shapeErrors(doc) {
	const errors = [];
	for (const k of Object.keys(doc)) {
		if (V2_KEYS.includes(k)) continue;
		if (V1_REPLACEMENTS[k]) errors.push(`\`${k}\` is a v1 key — use ${V1_REPLACEMENTS[k]}`);
		else errors.push(`unknown key \`${k}\` — a descriptor's keys are ${V2_KEYS.join(' · ')}`);
	}
	if (doc.overlay !== undefined && doc.overlay !== true) errors.push('`overlay` is `true` or absent — the base is the one source of this collection without it');
	const s = doc.storage ?? {};
	for (const k of Object.keys(s)) {
		if (STORAGE_KEYS.includes(k)) continue;
		errors.push(STORAGE_V1[k] ? `\`storage.${k}\` is a v1 key — use ${STORAGE_V1[k]}` : `unknown key \`storage.${k}\` — storage keys are ${STORAGE_KEYS.join(' · ')}`);
	}
	if (s.format !== undefined && !['md', 'yaml', 'json', 'binary'].includes(s.format)) errors.push('`storage.format` is md · yaml · json · binary');
	if (s.shape !== undefined && !['file', 'folder'].includes(s.shape)) errors.push('`storage.shape` is file · folder');
	if (s.under !== undefined) {
		const u = s.under;
		if (!u || typeof u !== 'object') errors.push('`storage.under` is { parent, subfolder }');
		else {
			for (const k of Object.keys(u)) if (!['parent', 'subfolder'].includes(k)) errors.push(k === 'field' || k === 'path' ? `\`storage.under.${k}\` is a v1 key — use \`${k === 'field' ? 'parent' : 'subfolder'}\`` : `unknown key \`storage.under.${k}\``);
			if (!u.parent || !u.subfolder) errors.push('`storage.under` needs both `parent` (a reference field of this collection) and `subfolder`');
		}
	}
	if (doc.ids !== undefined) {
		for (const k of Object.keys(doc.ids)) if (!['from', 'pattern'].includes(k)) errors.push(k === 'generate' ? '`ids.generate` is a v1 key — use `ids.from`' : `unknown key \`ids.${k}\``);
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

/**
 * Translate a (mixin-merged) v2 descriptor into the internal shape compile, the store, check and
 * the surfaces read today. `collections` is every collection name a type may name.
 * @returns {{ internal: object, resolved: object, defaults: object, errors: string[] }}
 */
export function toInternal(doc, { collections, peers, runtime = false }) {
	const { fields: resolved, errors, warnings, defaults } = resolveFields(doc.fields, { name: doc.name, collections, peers, runtime });
	// an overlay adds fields to a base that already carries the injected ones
	if (doc.overlay) for (const k of ['id', 'created', 'last_modified']) delete resolved[k];
	const internal = { name: doc.name };
	for (const k of ['title', 'singular', 'description', 'use_when', 'sensitive']) if (doc[k] !== undefined) internal[k] = doc[k];
	if (doc.record_title !== undefined) internal.title_template = doc.record_title;
	if (doc.internal) internal.group = 'system';
	else if (doc.display?.nav?.section !== undefined) internal.group = doc.display.nav.section;
	if (doc.display?.nav?.icon !== undefined) internal.icon = doc.display.nav.icon;
	if (doc.display?.nav?.order !== undefined) internal.order = doc.display.nav.order;
	// the internal shape still spells the injected column the v1 way
	if (doc.display?.list?.columns !== undefined) internal.list_fields = doc.display.list.columns.map((c) => (c === 'last_modified' ? 'last-modified' : c));
	const position = Object.entries(doc.fields ?? {}).find(([, f]) => f?.type === 'position')?.[0];
	if (position) internal.sort_field = position;
	// storage and id only where AUTHORED: an overlay that carried a default storage block would win
	// over its base's on merge, and the defaults are compile's to supply anyway
	if (doc.storage !== undefined) {
		const s = doc.storage;
		const storage = {};
		if (s.path !== undefined) storage.path = s.path;
		if (s.format !== undefined) storage.codec = s.format === 'binary' ? 'file' : s.format;
		if (s.shape !== undefined) storage.shape = s.shape;
		if (s.entry !== undefined) storage.entry = s.entry;
		if (s.suffix !== undefined) storage.suffix = s.suffix;
		if (s.under) storage.under = { field: s.under.parent, path: s.under.subfolder };
		if (s.max_bytes !== undefined) storage.max_bytes = s.max_bytes;
		if (s.accept !== undefined) storage.extensions = s.accept;
		internal.storage = storage;
	}
	if (doc.ids) internal.id = { ...(doc.ids.from !== undefined && { generate: doc.ids.from }), ...(doc.ids.pattern !== undefined && { pattern: doc.ids.pattern }) };
	const properties = {};
	const required = [];
	for (const [name, f] of Object.entries(resolved)) {
		if (f.virtual) continue;
		properties[name] = propertyOf(f, collections, peers);
		if (f.required) required.push(name);
	}
	internal.schema = { type: 'object', ...(required.length && { required }), properties };
	if (doc.constraints?.length) internal.schema.allOf = structuredClone(doc.constraints);
	return { internal, resolved, defaults, errors, warnings };
}

/** One resolved v2 field → the internal property. */
function propertyOf(f, collections, peers) {
	const known = new Set([...collections, ...(peers ?? [])]);
	const targets = referenceTargets(f.type, known);
	let item;
	if (targets) {
		item = { type: 'string', 'x-reference': targets[0] === '*' ? '*' : (Array.isArray(f.type) ? targets : targets[0]) };
		if (f.unique && f.mirror_of === undefined) item['x-unique'] = true;
		if (f.on_delete !== undefined && f.on_delete !== 'restrict') item['x-on-delete'] = f.on_delete;
	} else {
		item = scalarOf(f, collections, peers);
	}
	let p = item;
	if (f.many) {
		p = { type: 'array', items: item };
		for (const k of ['minItems', 'maxItems']) if (f[k] !== undefined) p[k] = f[k];
		if (f.item_title !== undefined) item['x-title-template'] = f.item_title;
	} else {
		for (const k of ['minItems', 'maxItems']) if (f[k] !== undefined) p[k] = f[k];
	}
	// value constraints describe ONE value, so on a list they sit on each item — exactly where
	// compiled.json_schema puts them (fields.js); dropping them for `many` let a write the validator's
	// own schema refuses through the store and check, which still read this shape
	for (const k of ['minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'const']) if (f[k] !== undefined) item[k] = f[k];
	if (f.default !== undefined) p.default = f.default;
	if (f.examples !== undefined) p.examples = f.examples;
	if (f.mirror_of !== undefined) p['x-inverse-of'] = `${targets[0]}.${f.mirror_of}`;
	if (f.body) p['x-body'] = true;
	if (f.sensitive) p['x-sensitive'] = true;
	if (f.derived) p.readOnly = true;
	if (f.title !== undefined) p.title = f.title;
	if (f.description !== undefined) p.description = f.description;
	return p;
}

function scalarOf(f, collections, peers) {
	switch (f.type) {
		case 'string': {
			if (f.enum === undefined) return { type: 'string' };
			const choices = enumChoices(f.enum);
			return { type: 'string', enum: enumValues(f.enum), ...(Object.keys(choices).length && { 'x-choices': choices }) };
		}
		case 'markdown': return { type: 'string', format: 'markdown' };
		case 'boolean': return { type: 'boolean' };
		case 'integer': return { type: 'integer' };
		case 'number': return { type: 'number' };
		case 'date': return { type: 'string', format: 'date' };
		case 'datetime': return { type: 'string', format: 'date-time' };
		case 'url': return { type: 'string', format: 'uri' };
		case 'email': return { type: 'string', format: 'email' };
		// the fractional key `dt reorder` writes — a-z by design, the same pattern compiled.json_schema states
		case 'position': return { type: 'string', pattern: '^[a-z]+$' };
		case 'map': {
			const v = f.values;
			const inner = typeof v === 'string' ? scalarOf({ type: v }, collections, peers) : v && typeof v === 'object' ? propertyOf(v, collections, peers) : {};
			return { type: 'object', additionalProperties: inner };
		}
		case 'object': {
			const properties = {};
			const required = [];
			for (const [k, v] of Object.entries(f.fields ?? {})) {
				properties[k] = propertyOf(v, collections, peers);
				if (v.required) required.push(k);
			}
			return { type: 'object', properties, ...(required.length && { required }) };
		}
		default: return { type: 'string' };
	}
}

/** The `compiled` block a v2 collection carries beside its authored keys. */
export function compiledBlock({ resolved, defaults, constraints, collections, merged }) {
	const block = {
		defaults: { ...(Object.keys(defaults).length && { fields: defaults }) },
		module: merged.module,
		repo: merged.storage.repo,
		runtime: merged.storage.base === 'runtime',
		...(merged.storage.under?.collection && { under_collection: merged.storage.under.collection }),
		mirrors: Object.entries(resolved).filter(([, f]) => f.mirror_of !== undefined).map(([k]) => k),
		overlaid_by: merged.overlays ?? [],
		unresolved_peers: merged.unresolved_peers ?? [],
		fields: resolved,
		json_schema: toJsonSchema(resolved, { constraints: constraints ?? [], collections }),
	};
	return block;
}

/** A base and its overlays as ONE v2 descriptor: overlay fields inserted before the body,
 *  constraints concatenated, every other key overlay-wins key by key (display per sub-block). */
export function mergeOverlays(base, overlays) {
	const out = structuredClone(base);
	for (const o of overlays) {
		const own = Object.entries(out.fields ?? {});
		const bodyAt = own.findIndex(([, f]) => f?.body);
		const add = Object.entries(o.fields ?? {}).filter(([k]) => !(k in (out.fields ?? {})));
		out.fields = Object.fromEntries(bodyAt < 0 ? [...own, ...add] : [...own.slice(0, bodyAt), ...add, ...own.slice(bodyAt)]);
		for (const [k] of Object.entries(o.fields ?? {})) if (k in (base.fields ?? {})) out.fields[k] = { ...out.fields[k], ...o.fields[k] };
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
