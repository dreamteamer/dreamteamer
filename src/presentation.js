// The display contract — compiled descriptors → what every surface draws (the extension, the mobile
// app, the REST layer). One read model, so no surface re-derives a label, a column list or a
// read-only rule from a descriptor on its own.
//
// It reads ONLY the compiled v2 shape: the authored keys (`title`, `record_title`, `internal`,
// `storage.suffix`, `display`), `compiled.defaults` for what compile supplied, `compiled.runtime`,
// and `compiled.fields` — the resolved field list, the three injected fields included. Every key it
// emits is a name from the design's display-contract table, one word per meaning;
// `test/unit/presentation-contract.test.js` lists them and fails on any other.
//
//   { collections: [CollectionRow], fields: { <collection>: [FieldRow] }, relations: [RelationRow] }
//
// Pure: no fs, no git, no workspace.
import { SCALAR_TYPES, enumValues, enumChoices, titleOf } from './fields.js';

/** The design's default layouts, used where `compiled.defaults.display` does not state them. */
const DEFAULT_LIST_LAYOUT = 'table';
const DEFAULT_RECORD_LAYOUT = 'page';

/** The wire type of a field: the authored type name, except that a reference travels as a string
 *  (its `role` says it is one). */
const WIRE_TYPES = new Set(['string', 'markdown', 'integer', 'number', 'boolean', 'date', 'datetime', 'url', 'email', 'object', 'map', 'position']);

/** The keys an enum map entry may carry onto a choice row, copied by name: a descriptor is authored
 *  data, and spreading it would let a workspace inject keys into a contract every surface reads. */
const CHOICE_KEYS = ['description', 'icon', 'color', 'background'];

/** the projection for every collection */
export function presentation(descriptors) {
	const all = [...descriptors.values()];
	// an owner field "has a relation" when some collection mirrors it — the far side names it
	const mirrored = new Set();
	for (const d of all) for (const f of Object.values(fieldsOf(d))) if (f.mirror_of !== undefined) mirrored.add(`${f.type}\0${f.mirror_of}`);
	const collections = [];
	const fields = {};
	const relations = [];
	const order = (d) => displayOf(d).nav.order ?? Infinity;
	for (const d of all.sort((a, b) => order(a) - order(b))) {
		const declared = fieldsOf(d);
		const { form } = displayOf(d);
		collections.push(collectionRow(d, declared));
		// the section a field is drawn in: its own `form_section`, else the authored section listing it
		const sectionOf = new Map((form.sections ?? []).flatMap((s) => s.fields.map((n) => [n, s.title])).reverse());
		fields[d.name] = Object.entries(declared).map(([name, f]) => {
			const row = { collection: d.name, ...fieldRow(name, f, d.compiled.defaults.fields?.[name]) };
			const section = f.display?.form_section ?? sectionOf.get(name);
			if (section !== undefined && !f.deprecated) row.form_section = section;
			return row;
		});
		for (const [name, f] of Object.entries(declared)) {
			const mirror = f.mirror_of !== undefined;
			const kind = mirror || !mirrored.has(`${d.name}\0${name}`) ? undefined : f.many ? 'm2m' : f.unique ? 'o2o' : 'm2o';
			for (const target of collectionTargets(f.type)) {
				relations.push({ collection: d.name, field: name, related_collection: target, list: f.many === true, ...pick({ kind, mirror: mirror || undefined }, ['kind', 'mirror']) });
			}
		}
	}
	return { collections, fields, relations };
}

/** `compiled.fields` — none for a descriptor compile did not resolve, which is no v2 descriptor */
const fieldsOf = (d) => d.compiled?.fields ?? {};

/** the authored `display` with its four sub-blocks present */
const displayOf = (d) => ({ nav: {}, list: {}, record: {}, form: {}, ...d.display });

/** the keys of `src` that are defined, in `keys` order */
function pick(src, keys) {
	const out = {};
	for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
	return out;
}

function collectionRow(d, declared) {
	const { defaults = {}, runtime } = d.compiled ?? {};
	const { nav, list, record, form } = displayOf(d);
	const dflt = { list: {}, record: {}, ...defaults.display };
	const drawn = (n) => declared[n] && !declared[n].deprecated; // a deprecated field is drawn nowhere
	const row = {
		collection: d.name,
		title: d.title ?? defaults.title,
		nav: pick(nav, ['icon', 'order', 'section']),
		list: { layout: list.layout ?? dflt.list.layout ?? DEFAULT_LIST_LAYOUT, ...pick({ ...list, columns: list.columns?.filter(drawn) }, ['columns', 'sort', 'options']) },
		record: { layout: record.layout ?? dflt.record.layout ?? DEFAULT_RECORD_LAYOUT, ...pick(record, ['subtitle', 'badge', 'color_by']) },
		// each authored section, plus the fields naming it through `display.form_section`, in field order
		form: {
			sections: (form.sections ?? []).map((s) => ({
				title: s.title,
				fields: [...s.fields, ...Object.keys(declared).filter((n) => declared[n].display?.form_section === s.title && !s.fields.includes(n))].filter(drawn),
			})),
		},
		...pick({
			position_field: Object.keys(declared).find((k) => declared[k].type === 'position'),
			record_title: d.record_title ?? defaults.record_title,
		}, ['position_field', 'record_title']),
		record_type: d.storage?.suffix ?? defaults.storage?.suffix ?? d.name,
		runtime: runtime === true,
		internal: d.internal === true,
	};
	return row;
}

/** The named collections a reference field points at; none for a non-reference and for `reference`
 *  (polymorphic: any collection, so no relation row). */
function collectionTargets(type) {
	if (Array.isArray(type)) return type;
	return type === 'reference' || SCALAR_TYPES.includes(type) ? [] : [type];
}

/** One field as surfaces draw it. `defaults` is the field's entry in `compiled.defaults.fields`. */
function fieldRow(name, f, defaults = {}) {
	const display = f.display ?? {};
	// Three engine-held kinds of read-only: a mirror the owner's write maintains, a stored value only
	// the engine writes (`created`), a value computed on read. Every writer is refused, so no surface
	// offers a control. `display.editable` locks only the UI and lets the CLI and syncs through.
	const kind = f.mirror_of !== undefined ? 'mirror' : f.derived ? 'derived' : f.virtual ? 'virtual' : undefined;
	const reference = f.type === 'reference' || collectionTargets(f.type).length > 0;
	const role = f.body ? 'body' : kind === 'mirror' ? 'mirror' : !reference ? undefined : f.many ? 'reference_many' : 'reference';
	// a deprecated field still validates and is drawn nowhere
	const hidden = f.deprecated ? ['list', 'form', 'record'] : INJECTED_HIDDEN[name]?.(f) ?? display.hidden;
	const options = componentOptions(f);
	return {
		field: name,
		// the authored type name; a reference travels as a string, and its `role` says it is one
		type: WIRE_TYPES.has(f.type) ? f.type : 'string',
		title: f.title ?? defaults.title ?? titleOf(name),
		...pick({ description: f.description || undefined }, ['description']),
		required: f.required === true,
		...pick({ many: f.many || undefined, kind }, ['many', 'kind']),
		editable: kind ? false : display.editable ?? true,
		...pick({ hidden: hidden?.length ? [...hidden] : undefined, role }, ['hidden', 'role']),
		...pick({ ...display, editor_options: options, viewer_options: options }, ['editor', 'editor_options', 'viewer', 'viewer_options']),
		...pick(f, ['mirror_of', 'on_delete']),
		...pick({ unique: f.unique || undefined }, ['unique']),
		nullable: f.required !== true,
		...pick(f, ['default']),
		...pick(display, ['unit', 'unit_field', 'direction', 'width', 'placeholder']),
		...pick({ deprecated: f.deprecated || undefined, sensitive: f.sensitive || undefined }, ['deprecated', 'sensitive']),
	};
}

/** Where the three injected fields are not drawn: `id` is the record's address, never a value to show
 *  or edit; `created` and `last_modified` are listable and never on the form. */
const INJECTED_HIDDEN = {
	id: (f) => (f.virtual ? ['list', 'form', 'record'] : undefined),
	created: (f) => (f.derived ? ['form'] : undefined),
	last_modified: (f) => (f.virtual ? ['form'] : undefined),
};

/** What a field's component needs beyond the field itself: the enum's choice rows, an object's
 *  sub-fields and row label, and the authored `display.options`. Undefined when there is none. */
function componentOptions(f) {
	const decoration = enumChoices(f.enum);
	const out = {
		...pick({
			choices: f.enum === undefined ? undefined : enumValues(f.enum).map((v) => choiceRow(v, decoration[v])),
			fields: f.type === 'object' ? Object.entries(f.fields).map(([n, sub]) => fieldRow(n, sub)) : undefined,
			item_title: f.item_title,
		}, ['choices', 'fields', 'item_title']),
		...f.display?.options,
	};
	return Object.keys(out).length ? out : undefined;
}

/** One choice row: the value, its label (the value itself when none is authored), and the decoration
 *  keys the enum map carries — copied by name, and only when they are non-empty strings. */
function choiceRow(value, entry = {}) {
	const row = { label: String(entry.label ?? value), value };
	for (const k of CHOICE_KEYS) if (typeof entry[k] === 'string' && entry[k]) row[k] = entry[k];
	return row;
}
