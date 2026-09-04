// presentation projection — descriptor → "how to render each field" rows, served at
// GET /api/presentation. this is the ADAPTER INVERSION (review, M3): the mapping the
// studio's transitional adapter synthesized client-side is genuinely useful, so it moves
// into the clean contract as an explicit projection; the studio consumes ONE contract and
// the client adapter shrinks to a thin path translator. shapes deliberately match what
// the studio components already speak (field {field,type,meta,schema}).

// `sourceHint` is deliberately NOT imported here any more — see the note beside `system` below.
// It survives for the store's own refusal (`store.js`) and `revert`'s (`collections-cli.js`), both
// of which are still true statements about a path that genuinely cannot be written.
import { refTargetsOf } from './ref.js';

/** the projection for every collection: rows keyed by collection name + collection meta. */
export function presentation(descriptors) {
	const collections = [];
	const fields = {};
	const relations = [];
	for (const d of [...descriptors.values()].sort((a, b) => (a.order ?? 999) - (b.order ?? 999))) {
		collections.push(collectionRow(d));
		const rows = [];
		rows.push({
			field: 'id',
			type: 'string',
			meta: { collection: d.name, field: 'id', hidden: true, readonly: true, edit: 'input' },
			schema: { name: 'id', is_primary_key: true, is_nullable: false },
		});
		// Synthesized like `id` above — never a schema property, so it's never written to disk
		// (unknownFields would reject it) and never touches a collection's real frontmatter
		// contract. `readonly: true` (not `hidden`) so it's a browse column and sortable; `formHidden`
		// (studio-only convention, not a Directus concept — ContentDetail filters on it before handing
		// fields to ItemForm) keeps it OUT of the record form now that PageHeader shows the richer
		// author/message/date line instead (operator ask 2026-07-27). Computed server-side per
		// request (server.js) from `git log` on the record's file — null for anything the compiled
		// `.dreamteamer/` runtime backs (skills/agents/commands/…, gitignored) since there's no
		// meaningful history to read there.
		rows.push({
			field: 'last-modified',
			type: 'timestamp',
			meta: { collection: d.name, field: 'last-modified', readonly: true, formHidden: true, view: 'date', view_options: { relative: true } },
			schema: { name: 'last-modified', is_primary_key: false, is_nullable: true, default_value: null },
		});
		for (const [name, prop] of Object.entries(d.schema?.properties ?? {})) {
			if (name === 'id') continue;
			rows.push(fieldRow(d, name, prop, new Set(d.schema?.required ?? []).has(name), descriptors));
			const targets = referenceTargetsOf(prop);
			if (targets) {
				const h = holderOf(prop);
				// `kind` belongs to the OWNING side of an actual relation only, and uses the same three
				// names src/relations.js decodes — no surface learns a second vocabulary. A mirror is
				// the far end of a relation, not one with a cardinality of its own, so it is flagged
				// rather than typed.
				const mirror = h['x-inverse-of'] !== undefined;
				const kind = mirror || h['x-inverse'] === undefined
					? undefined
					: prop.type === 'array' ? 'm2m' : h['x-unique'] === true ? 'o2o' : 'm2o';
				for (const target of targets) {
					relations.push({
						collection: d.name, field: name, related_collection: target, list: prop.type === 'array',
						...(kind && { kind }), ...(mirror && { mirror: true }),
					});
				}
			}
		}
		fields[d.name] = rows;
	}
	return { collections, fields, relations };
}

function collectionRow(d) {
	const props = d.schema?.properties ?? {};
	const titleField = ['title', 'name', 'subject'].find((f) => f in props);
	const meta = { collection: d.name, record_type: d.storage?.suffix ?? d.name };
	// resolved by compile — a surface renders this and never title-cases an id itself
	if (typeof d.title === 'string' && d.title.length > 0) meta.title = d.title;
	if (typeof d.title_template === 'string' && d.title_template.length > 0) meta.title_template = d.title_template;
	if (titleField) meta.title_field = titleField;
	if (typeof d.order === 'number') meta.order = d.order;
	if (Array.isArray(d.list_fields)) meta.list_fields = d.list_fields;
	if (typeof d.icon === 'string') meta.icon = d.icon;
	// Manual ordering: a surface can only offer a drag handle if it knows WHICH field a drop writes,
	// and the field name is per-collection. Without this the descriptor key exists and no UI can see
	// it — the extension reads the presentation contract, not raw descriptors.
	if (typeof d.sort_field === 'string') meta.sort_field = d.sort_field;

	if (typeof d.group === 'string') meta.group = d.group;
	if (typeof d.description === 'string' && d.description.length > 0) meta.description = d.description;
	// ⚠ `system` IS NOT `readonly`, AND SAYING SO COST A RELEASE. Until 0.19.0 the two were the
	// same fact: nothing could write a compiled entity, so this projection set `meta.readonly` for
	// every `storage.base === 'runtime'` collection and the UI disabled the form. 0.19.0 gave the
	// record verbs a system write path — `set skills/<id>`, `rename`, `rm`, `set collections/<c>`,
	// `set modules/<id>` — dispatched at the SURFACE, around the store (`collections-cli.js`,
	// `server.js`). This file was never touched by that wave, so the projection kept describing the
	// old world and a skill in the workspace's own `modules/<m>/skills/` rendered padlocked while
	// `dt set` wrote it happily.
	//
	// So no collection-level readonly is emitted for a system kind any more. Three reasons it is a
	// DELETION rather than a narrower predicate:
	//
	//   1. Writability is per RECORD, not per collection. `skills/<one>` authored in an inline
	//      module is writable; `skills/<another>` shipped from `node_modules/` is refused, because
	//      the next `npm install` erases the edit. One flag on the collection cannot say both, and
	//      a flag that is wrong half the time is worse than none.
	//   2. On today's verb set there is no system kind with no writable path at all, so a correct
	//      collection-level predicate would be constant-false.
	//   3. The refusals that remain are per record (npm-shipped), per verb (`revert`, and `add` on
	//      the hand-authored kinds) or per field (`x-body`) — none of them collection-shaped. Each
	//      already answers with its own sentence naming the fix, which is the contract the schema
	//      surfaces are built on.
	//
	// `system` STAYS and is unchanged: the CLI and REST dispatch key on it, and it is what puts a
	// kind in the schema surface rather than the data one. A consumer that disables editing must
	// key on `meta.readonly` (per field, as `id`, `last-modified` and relation mirrors do) or on
	// the verb it is about to offer — never on `system`.
	const system = d.storage?.base === 'runtime';
	return { collection: d.name, meta, system };
}

/** The node a reference field's keywords live on: `items` for a list, the property itself for a
 *  scalar. compile hoists them there, and every relation consumer reads them from there. */
function holderOf(prop) {
	return (prop.items && typeof prop.items === 'object') ? prop.items : prop;
}

/** The named target collections of a reference field — null for a non-ref and for '*'. */
function referenceTargetsOf(prop) {
	const targets = refTargetsOf(prop);
	return targets && targets !== '*' ? targets : null;
}

/**
 * The template that renders a VALUE of this field as a human label.
 *
 * Authored per-field with `x-title-template`, else INHERITED from the target collection's
 * `title_template` — because "a company is labelled by its name" is a fact about companies, not
 * about each of the eleven fields that point at one. Before this, that fact was hand-copied onto
 * every referencing field as `x-display: '{{ name }}'`; 51 of the 54 sites in this workspace were
 * exactly what the target already implies. A UNION field inherits only when every member agrees —
 * a template that renders half the values wrong is worse than the raw qualified ref, which is at
 * least always correct.
 */
function titleTemplateOf(prop, descriptors) {
	// Keyed off prop.items itself, not prop.type === 'array': the compile hoist moves an authored
	// x-title-template onto whichever node CARRIES x-reference, which for an items-bearing property
	// is `items` regardless of whether `type: array` was also spelled out explicitly. Reading by
	// `type` diverged from that and silently dropped the authored template for such a field.
	const own = prop.items?.['x-title-template'] ?? prop['x-title-template'];
	if (typeof own === 'string' && own.length > 0) return own;
	const targets = referenceTargetsOf(prop);
	if (!targets) return undefined;
	const inherited = targets.map((t) => descriptors.get(t)?.title_template);
	const first = inherited[0];
	return typeof first === 'string' && first.length > 0 && inherited.every((v) => v === first) ? first : undefined;
}

function fieldRow(d, name, prop, isRequired, descriptors) {
	const meta = { collection: d.name, field: name };
	if (isRequired) meta.required = true;
	// JSON Schema's own `description` on the property — what the field MEANS, authored in the
	// module source beside the field. Carried through verbatim so a surface can explain a field
	// without a second vocabulary (the UI shows it as the property row's tooltip).
	if (typeof prop.description === 'string' && prop.description.length > 0) meta.description = prop.description;
	// resolved by compile (titleCase of the field name unless authored) — the label every surface
	// shows, so no component title-cases a field name on its own.
	if (typeof prop.title === 'string' && prop.title.length > 0) meta.title = prop.title;

	let type = 'string';
	const targets = referenceTargetsOf(prop); // plural: x-reference may name several collections; only truthiness is used below

	if (prop['x-body'] === true) {
		type = 'text';
		meta.special = ['dt-body'];
		meta.edit = 'input-rich-text-md';
	} else if (targets && prop.type !== 'array') {
		meta.special = ['dt-relation-path'];
	} else if (targets && prop.type === 'array') {
		type = 'json';
		meta.special = ['dt-relation-path', 'dt-relation-list'];
	} else if (prop.type === 'array' && prop.items?.type === 'object') {
		type = 'json';
		meta.edit = 'list';
		meta.view = 'list';
		const listOptions = { fields: optionFieldsOf(prop.items) };
		if (typeof prop.items['x-title-template'] === 'string') listOptions.template = prop.items['x-title-template'];
		meta.edit_options = listOptions;
		meta.view_options = listOptions;
	} else if (prop.type === 'array') {
		type = 'json';
		meta.edit = 'tags';
		meta.view = 'tags';
	} else if (prop.type === 'boolean') {
		type = 'boolean';
	} else if (prop.type === 'integer') {
		type = 'integer';
	} else if (prop.type === 'number') {
		type = 'float';
	} else if (prop.type === 'object') {
		type = 'json';
		if (prop.properties && Object.keys(prop.properties).length > 0) {
			meta.edit = 'nested';
			meta.view = 'nested';
			const nestedOptions = { fields: optionFieldsOf(prop) };
			meta.edit_options = nestedOptions;
			meta.view_options = nestedOptions;
		}
	} else if (prop.format === 'date') {
		type = 'date';
	} else if (prop.format === 'date-time') {
		type = 'timestamp';
	} else if (prop.format === 'markdown') {
		type = 'text';
	}

	// The two SIDES of a relation render differently, and only the descriptor knows which side a
	// field is on. The owner is writable and carries the delete policy a surface should warn about
	// before it offers the button; the generated mirror is READ-ONLY, and a UI that offers to edit
	// one produces a write the store refuses — an error after the click, which is a worse answer
	// than a disabled control with a reason (the same rule collectionRow follows for a compiled
	// collection). `dt-relation-mirror` names the SHAPE, not a component: what the extension draws
	// for it is the extension's business.
	if (targets) {
		const holder = holderOf(prop);
		if (holder['x-inverse-of']) {
			meta.readonly = true;
			meta.inverse_of = holder['x-inverse-of'];
			if (typeof prop.description === 'string' && prop.description.length > 0) meta.readonly_hint = prop.description;
			meta.special = [...(meta.special ?? []), 'dt-relation-mirror'];
		} else if (holder['x-inverse']) {
			meta.inverse = holder['x-inverse'];
			if (holder['x-unique'] === true) meta.unique = true;
			// stated rather than implied: `restrict` is what the store enforces when nothing is authored
			meta.on_delete = holder['x-on-delete'] ?? 'restrict';
		}
	}

	if (Array.isArray(prop.enum) && prop.enum.length > 0) {
		meta.edit_options = { choices: prop.enum.map((v) => ({ text: String(v), value: v })) };
	}
	const tpl = titleTemplateOf(prop, descriptors);
	if (typeof tpl === 'string' && tpl.length > 0) meta.view_options = { ...meta.view_options, template: tpl };

	return {
		field: name,
		type,
		meta,
		schema: { name, is_primary_key: false, is_nullable: !isRequired, default_value: prop.default ?? null },
	};
}

// sub-form shape (EditList rows / EditNested objects) derived recursively
function optionFieldsOf(objSchema) {
	return Object.entries(objSchema.properties ?? {}).map(([field, prop]) => {
		const def = { field, name: field, type: 'string' };
		if (Array.isArray(prop.enum) && prop.enum.length > 0) {
			def.edit = 'select-dropdown';
			def.edit_options = { choices: prop.enum.map((v) => ({ text: String(v), value: v })) };
		} else if (prop.type === 'boolean') {
			def.type = 'boolean';
		} else if (prop.type === 'integer' || prop.type === 'number') {
			def.type = prop.type === 'integer' ? 'integer' : 'float';
		} else if (prop.type === 'array' && prop.items?.type === 'object') {
			def.type = 'json';
			def.edit = 'list';
			def.edit_options = { fields: optionFieldsOf(prop.items) };
		} else if (prop.type === 'array') {
			def.type = 'json';
			def.edit = 'tags';
		} else if (prop.type === 'object' && prop.properties && Object.keys(prop.properties).length > 0) {
			def.type = 'json';
			def.edit = 'nested';
			def.edit_options = { fields: optionFieldsOf(prop) };
		} else if (prop.type === 'object') {
			def.type = 'json';
		} else if (prop.format === 'markdown') {
			def.type = 'text';
		}
		return def;
	});
}
