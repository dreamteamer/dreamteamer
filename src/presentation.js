// presentation projection — descriptor → "how to render each field" rows, served at
// GET /api/presentation. this is the ADAPTER INVERSION (review, M3): the mapping the
// studio's transitional adapter synthesized client-side is genuinely useful, so it moves
// into the clean contract as an explicit projection; the studio consumes ONE contract and
// the client adapter shrinks to a thin path translator. shapes deliberately match what
// the studio components already speak (field {field,type,meta,schema}).

import { sourceHint } from './runtime.js';

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
			const target = referenceTargetOf(prop);
			if (target) {
				relations.push({ collection: d.name, field: name, related_collection: target, list: prop.type === 'array' });
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
	if (typeof d.group === 'string') meta.group = d.group;
	if (typeof d.description === 'string' && d.description.length > 0) meta.description = d.description;
	// A compiled collection is READ-ONLY through the record layer, and the UI needs to say so
	// BEFORE offering a button — an error after the click is a worse answer than a disabled
	// control with a reason. The sentence comes from runtime.js so the store's refusal and this
	// hint can never disagree.
	const system = d.storage?.base === 'runtime';
	if (system) {
		meta.readonly = true;
		meta.readonly_hint = sourceHint(d);
	}
	return { collection: d.name, meta, system };
}

function referenceTargetOf(prop) {
	const ref = prop.type === 'array' ? prop.items?.['x-reference'] : prop['x-reference'];
	if (typeof ref !== 'string' || ref === '' || ref === '*') return null;
	return ref;
}

/**
 * The template that renders a VALUE of this field as a human label.
 *
 * Authored per-field with `x-title-template`, else INHERITED from the target collection's
 * `title_template` — because "a company is labelled by its name" is a fact about companies, not
 * about each of the eleven fields that point at one. Before this, that fact was hand-copied onto
 * every referencing field as `x-display: '{{ name }}'`; 51 of the 54 sites in this workspace were
 * exactly what the target already implies.
 */
function titleTemplateOf(prop, descriptors) {
	const own = prop.type === 'array' ? prop.items?.['x-title-template'] : prop['x-title-template'];
	if (typeof own === 'string' && own.length > 0) return own;
	const target = referenceTargetOf(prop);
	const inherited = target ? descriptors.get(target)?.title_template : undefined;
	return typeof inherited === 'string' && inherited.length > 0 ? inherited : undefined;
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
	const target = referenceTargetOf(prop);

	if (prop['x-body'] === true) {
		type = 'text';
		meta.special = ['dt-body'];
		meta.edit = 'input-rich-text-md';
	} else if (target && prop.type !== 'array') {
		meta.special = ['dt-relation-path'];
	} else if (target && prop.type === 'array') {
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
