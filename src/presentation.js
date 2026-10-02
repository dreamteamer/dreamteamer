// The display contract — compiled descriptors → what every surface draws (the extension, the mobile
// app, the REST layer). One read model, so no surface re-derives a label, a column list or a
// read-only rule from a descriptor on its own.
//
// It reads a compiled descriptor ONLY through `src/descriptor.js` — the accessors resolve what the
// author wrote over what compile supplied (`displayOf`, `titleOf`, `recordTitleOf`, `storageOf`) and
// hand over the resolved field list, the three injected fields included (`fieldsOf`). Nothing here
// names a `compiled` key, so the contract cannot drift from what the store and check read. Every key
// it emits is a name from the design's display-contract table, one word per meaning;
// `test/unit/presentation-contract.test.js` lists them and fails on any other.
//
//   { collections: [CollectionRow], fields: { <collection>: [FieldRow] }, relations: [RelationRow] }
//
// Pure: no fs, no git, no workspace.
import { enumValues, enumChoices, titleOf as fieldTitle } from './fields.js';
import {
	fieldsOf, displayOf as resolvedDisplayOf, titleOf, recordTitleOf, storageOf, positionFieldOf, bodyFieldOf,
	requiredOf, targetsOf, mirrorOf, isRuntime, isInternal,
} from './descriptor.js';

/** The design's default layouts, used where the resolved `display` (`displayOf`) does not state them. */
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
	for (const d of all) {
		for (const f of Object.values(fieldsOf(d))) {
			if (mirrorOf(f) !== undefined) for (const t of collectionTargets(f)) mirrored.add(`${t}\0${mirrorOf(f)}`);
		}
	}
	const collections = [];
	const fields = {};
	const relations = [];
	const order = (d) => displayOf(d).nav.order ?? Infinity;
	for (const d of all.sort((a, b) => order(a) - order(b))) {
		const declared = fieldsOf(d);
		const { form } = displayOf(d);
		const required = new Set(requiredOf(d));
		const body = bodyFieldOf(d);
		collections.push(collectionRow(d, declared));
		// the section a field is drawn in: its own `form_section`, else the authored section listing it
		const sectionOf = new Map((form.sections ?? []).flatMap((s) => s.fields.map((n) => [n, s.title])).reverse());
		fields[d.name] = Object.entries(declared).map(([name, f]) => {
			const row = { collection: d.name, ...fieldRow(name, f, { required: required.has(name), body: name === body }) };
			const section = f.display?.form_section ?? sectionOf.get(name);
			if (section !== undefined && !f.deprecated) row.form_section = section;
			return row;
		});
		for (const [name, f] of Object.entries(declared)) {
			const mirror = mirrorOf(f) !== undefined;
			const kind = mirror || !mirrored.has(`${d.name}\0${name}`) ? undefined : f.many ? 'm2m' : f.unique ? 'o2o' : 'm2o';
			for (const target of collectionTargets(f)) {
				relations.push({ collection: d.name, field: name, related_collection: target, list: f.many === true, ...pick({ kind, mirror: mirror || undefined }, ['kind', 'mirror']) });
			}
		}
	}
	return { collections, fields, relations };
}

/** the resolved `display` — authored over compile's defaults — with its four sub-blocks present */
const displayOf = (d) => ({ nav: {}, list: {}, record: {}, form: {}, ...resolvedDisplayOf(d) });

/** the keys of `src` that are defined, in `keys` order */
function pick(src, keys) {
	const out = {};
	for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
	return out;
}

function collectionRow(d, declared) {
	const { nav, list, record, form } = displayOf(d);
	const drawn = (n) => declared[n] && !declared[n].deprecated; // a deprecated field is drawn nowhere
	return {
		collection: d.name,
		title: titleOf(d),
		nav: pick(nav, ['icon', 'order', 'section']),
		list: { layout: list.layout ?? DEFAULT_LIST_LAYOUT, ...pick({ ...list, columns: list.columns?.filter(drawn) }, ['columns', 'sort', 'options']) },
		record: { layout: record.layout ?? DEFAULT_RECORD_LAYOUT, ...pick(record, ['subtitle', 'badge', 'color_by', 'options']) },
		// each authored section, plus the fields naming it through `display.form_section`, in field order;
		// a section only fields name follows the authored ones, in the order its first field comes
		form: {
			sections: [...(form.sections ?? []).map((s) => s.title), ...Object.values(declared).map((f) => f.display?.form_section)]
				.filter((t, i, all) => t !== undefined && all.indexOf(t) === i)
				.map((title) => {
					const authored = (form.sections ?? []).find((s) => s.title === title)?.fields ?? [];
					return { title, fields: [...authored, ...Object.keys(declared).filter((n) => declared[n].display?.form_section === title && !authored.includes(n))].filter(drawn) };
				}),
		},
		...pick({ position_field: positionFieldOf(d), record_title: recordTitleOf(d) }, ['position_field', 'record_title']),
		record_type: storageOf(d).suffix ?? d.name,
		runtime: isRuntime(d),
		internal: isInternal(d),
	};
}

/** The named collections a reference field points at; none for a non-reference and for `reference`
 *  (`'*'`, polymorphic: any collection, so no relation row). */
function collectionTargets(f) {
	const t = targetsOf(f);
	return Array.isArray(t) ? t : [];
}

/** One field as surfaces draw it. `required` and `body` are the collection's answers
 *  (`requiredOf`, `bodyFieldOf`); an object's sub-field, which no collection accessor covers, says
 *  its own. The title is the resolved one — compile wrote its default onto the field. */
function fieldRow(name, f, { required = f.required === true, body = f.body === true } = {}) {
	const display = f.display ?? {};
	// Three engine-held kinds of read-only: a mirror the owner's write maintains, a stored value only
	// the engine writes (`created`), a value computed on read. Every writer is refused, so no surface
	// offers a control. `display.editable` locks only the UI and lets the CLI and syncs through.
	const kind = mirrorOf(f) !== undefined ? 'mirror' : f.derived ? 'derived' : f.virtual ? 'virtual' : undefined;
	const reference = targetsOf(f) !== null;
	const role = body ? 'body' : kind === 'mirror' ? 'mirror' : !reference ? undefined : f.many ? 'reference_many' : 'reference';
	// a deprecated field still validates and is drawn nowhere
	const hidden = f.deprecated ? ['list', 'form', 'record'] : INJECTED_HIDDEN[name]?.(f) ?? display.hidden;
	const options = componentOptions(f);
	return {
		field: name,
		// the authored type name; a reference travels as a string, and its `role` says it is one
		type: WIRE_TYPES.has(f.type) ? f.type : 'string',
		title: f.title ?? fieldTitle(name),
		...pick({ description: f.description || undefined }, ['description']),
		required,
		...pick({ many: f.many || undefined, kind }, ['many', 'kind']),
		editable: kind ? false : display.editable ?? true,
		...pick({ hidden: hidden?.length ? [...hidden] : undefined, role }, ['hidden', 'role']),
		...pick({ ...display, editor_options: options, viewer_options: options }, ['editor', 'editor_options', 'viewer', 'viewer_options']),
		...pick({ mirror_of: mirrorOf(f), on_delete: f.on_delete }, ['mirror_of', 'on_delete']),
		...pick({ unique: f.unique || undefined }, ['unique']),
		nullable: !required,
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
