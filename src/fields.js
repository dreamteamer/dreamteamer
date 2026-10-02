// The field vocabulary — dreamteamer's own, compiled to JSON Schema.
//
// An authored descriptor declares `fields` in the words a person uses (`type: datetime`, `required: true`,
// `many: true`, `type: <collection>`); compile resolves them (defaults applied, mixins and overlays merged,
// the three injected fields added) into `compiled.fields`, which every consumer reads, and emits
// `compiled.json_schema`, which the validator alone reads. The two never carry the same fact in two
// vocabularies: there is no `x-` keyword anywhere, and `json_schema.properties` is exactly the stored
// (non-virtual) fields, type-mapped — `test/unit/fields.test.js` pins that equality.
//
// This module is pure: no fs, no git, no knowledge of modules. It is handed the set of collection names
// that exist so a `type: <collection>` can be told from a typo, and returns errors rather than throwing,
// so compile can attribute each one to a file.

/** The authored types, in the order the help text lists them. A collection may not be named after one. */
export const SCALAR_TYPES = ['string', 'markdown', 'boolean', 'integer', 'number', 'date', 'datetime', 'url', 'email', 'reference', 'object', 'map', 'position'];

/** The closed set of keys a field may carry. Anything else is a compile error naming the key. */
export const FIELD_KEYS = new Set([
	'type', 'title', 'required', 'many', 'default', 'enum', 'unique', 'mirror_of', 'on_delete', 'sensitive',
	'body', 'derived', 'virtual', 'deprecated', 'passthrough', 'fields', 'values', 'item_title',
	'examples', 'pattern', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'const',
	'display', 'description',
]);

/** The keys a field's `display` block may carry. */
export const DISPLAY_KEYS = new Set(['editable', 'hidden', 'form_section', 'placeholder', 'unit', 'unit_field', 'direction', 'width', 'viewer', 'editor', 'options']);

/** JSON Schema keywords copied onto the emitted property unchanged. */
const PASS_THROUGH = ['default', 'examples', 'pattern', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'const'];

/** The three fields every collection has. `created` is stored (engine-written); the other two are computed on read. */
export const INJECTED_FIELDS = {
	id: { type: 'string', title: 'Id', virtual: true, description: 'The record\'s path inside its collection.' },
	created: { type: 'datetime', title: 'Created', derived: true, description: 'When the record was first written. Stamped by the engine at add; read from the id\'s date or the first commit for a record written before it existed.' },
	last_modified: { type: 'datetime', title: 'Last modified', virtual: true, description: 'When the record was last committed, from git.' },
};

/** Is `type` a reference to one or more collections, given the names that exist? */
export function referenceTargets(type, collections) {
	if (type === 'reference') return ['*'];
	if (Array.isArray(type)) return type;
	if (typeof type === 'string' && !SCALAR_TYPES.includes(type) && collections.has(type)) return [type];
	return null;
}

/**
 * Resolve one collection's authored fields.
 * @param {object} authored   the descriptor's `fields` (mixins and overlays already merged in by compile)
 * @param {object} ctx        { name, collections: Set<string>, peers?: Set<string> }
 * @returns {{ fields: object, errors: string[], warnings: string[], defaults: object }}
 *   fields   — resolved: injected fields first, authored fields in order, every field with its type and keys as authored
 *   defaults — per field, the keys compile supplied (title today; on_delete on references)
 *   errors   — each naming the field and the key
 */
export function resolveFields(authored, ctx) {
	const errors = [];
	const warnings = [];
	const defaults = {};
	const known = new Set(Object.keys(authored ?? {}));
	const fields = {};
	// `created` is STAMPED by the store, which a kind whose records compile writes never goes through
	for (const [k, v] of Object.entries(INJECTED_FIELDS)) {
		if (k === 'created' && ctx.runtime) continue;
		if (known.has(k)) errors.push(`field "${k}" is injected by the engine and cannot be authored`);
		fields[k] = { ...v };
	}
	// a type may name an installed collection or a declared peer nobody installed yet
	const types = new Set([...ctx.collections, ...(ctx.peers ?? [])]);
	let bodies = 0;
	let positions = 0;
	for (const [name, prop] of Object.entries(authored ?? {})) {
		if (!prop || typeof prop !== 'object' || Array.isArray(prop)) { errors.push(`field "${name}" must be a map`); continue; }
		// a key copied verbatim into a harness keeps the harness's spelling, and says so
		// a WARNING: renaming a field is a record change (`dt rename-field`), which a compile must not force
		if (!/^[a-z][a-z0-9_]*$/.test(name) && !(prop.passthrough && /^[a-z][a-z0-9-]*$/.test(name))) warnings.push(`field "${name}": names are snake_case — \`dt rename-field\` renames it in every record (a key passed through to a harness in its own spelling is marked \`passthrough: true\`)`);
		for (const k of Object.keys(prop)) if (!FIELD_KEYS.has(k)) errors.push(`field "${name}" has unknown key "${k}" — the closed list is: ${[...FIELD_KEYS].join(' ')}`);
		const out = { ...prop };
		const targets = referenceTargets(prop.type, types);
		if (prop.type === undefined) errors.push(`field "${name}" has no type`);
		else if (!targets && !SCALAR_TYPES.includes(prop.type)) {
			errors.push(Array.isArray(prop.type)
				? `field "${name}": a union names collections, and ${JSON.stringify(prop.type)} is not all collections`
				: `field "${name}": unknown type "${prop.type}" — one of ${SCALAR_TYPES.join(' ')} or a collection name`);
		}
		if (Array.isArray(prop.type)) for (const t of prop.type) if (!types.has(t)) errors.push(`field "${name}": union member "${t}" is not a collection`);
		if (prop.type === 'object' && !prop.fields) errors.push(`field "${name}": type object needs \`fields\``);
		if (prop.fields && prop.type !== 'object') errors.push(`field "${name}": \`fields\` belongs to type object`);
		if (prop.values && prop.type !== 'map') errors.push(`field "${name}": \`values\` belongs to type map`);
		if (prop.item_title && !(prop.type === 'object' && prop.many)) errors.push(`field "${name}": \`item_title\` labels the rows of a \`many\` object`);
		if (prop.body) { bodies++; if (prop.type !== 'markdown') errors.push(`field "${name}": the body is \`type: markdown\``); }
		if (prop.type === 'position') { positions++; if (prop.many) errors.push(`field "${name}": a position is scalar`); }
		if (prop.enum !== undefined) {
			if (prop.type !== 'string') errors.push(`field "${name}": \`enum\` belongs to type string (there is no type enum)`);
			const values = enumValues(prop.enum);
			if (!values) errors.push(`field "${name}": \`enum\` is a list of values or a map of value → { label, description, icon, color, background }`);
			// a WARNING: renaming a value is a record change (`dt rename-value`), which a compile must not force
			else for (const v of values) if (!/^[a-z0-9][a-z0-9-]*$/.test(String(v))) warnings.push(`field "${name}": enum value "${v}" is not kebab-case — values are kebab-case, and the label belongs in the enum map (dt rename-value renames one)`);
		}
		if (prop.mirror_of !== undefined) {
			if (!targets || targets[0] === '*' || targets.length !== 1) errors.push(`field "${name}": \`mirror_of\` needs a type naming exactly one collection`);
			if (prop.required) errors.push(`field "${name}": a mirror cannot be required — the owner writes it`);
		}
		if (prop.on_delete !== undefined) {
			if (!targets) errors.push(`field "${name}": \`on_delete\` belongs to a reference`);
			if (!['restrict', 'set-null'].includes(prop.on_delete)) errors.push(`field "${name}": on_delete is restrict or set-null`);
			if (prop.on_delete === 'set-null' && prop.required) errors.push(`field "${name}": on_delete: set-null on a required reference would produce an invalid record`);
		}
		if (prop.unique && prop.many) errors.push(`field "${name}": \`unique\` is a value constraint on a scalar field`);
		if (prop.derived && prop.virtual) errors.push(`field "${name}": derived (stored, engine-written) and virtual (never stored) exclude each other`);
		if (prop.display) {
			for (const k of Object.keys(prop.display)) if (!DISPLAY_KEYS.has(k)) errors.push(`field "${name}": display has unknown key "${k}" — one of ${[...DISPLAY_KEYS].join(' ')}`);
			const { editable, hidden, unit_field } = prop.display;
			if (editable !== undefined && ![true, false, 'create'].includes(editable)) errors.push(`field "${name}": display.editable is true, false or create`);
			if (hidden !== undefined && (!Array.isArray(hidden) || hidden.some((h) => !['list', 'form', 'record'].includes(h)))) errors.push(`field "${name}": display.hidden lists list, form, record`);
			if (prop.required && prop.default === undefined && (editable === false || hidden?.includes('form'))) errors.push(`field "${name}": required with no default, but hidden from the form or not editable — nothing could create a record`);
			if (unit_field !== undefined && authored[unit_field]?.type !== 'string') errors.push(`field "${name}": display.unit_field "${unit_field}" is not a string field`);
		}
		// defaults compile supplies, recorded apart so the resolved field never looks authored where it was not
		const d = {};
		if (out.title === undefined) { out.title = titleOf(name); d.title = out.title; }
		if (targets && out.on_delete === undefined && out.mirror_of === undefined) { out.on_delete = 'restrict'; d.on_delete = 'restrict'; }
		if (Object.keys(d).length) defaults[name] = d;
		fields[name] = out;
	}
	if (bodies > 1) errors.push(`${bodies} fields declare body: true — a record has one body`);
	if (positions > 1) errors.push(`${positions} fields are type position — a collection has one manual order`);
	return { fields, errors, warnings, defaults };
}

/** The enum's value list, from a list or a map; null when it is neither. */
export function enumValues(e) {
	if (Array.isArray(e)) return e;
	if (e && typeof e === 'object') return Object.keys(e);
	return null;
}

/** The enum's decoration per value — `{ value: { label, description, icon, color, background } }` — from a map; {} from a list. */
export function enumChoices(e) {
	if (!e || Array.isArray(e) || typeof e !== 'object') return {};
	const out = {};
	for (const [v, row] of Object.entries(e)) {
		if (!row || typeof row !== 'object') continue;
		const r = {};
		for (const k of ['label', 'description', 'icon', 'color', 'background']) if (typeof row[k] === 'string') r[k] = row[k];
		out[v] = r;
	}
	return out;
}

/** The default field label — the same rule compile's titleCase has always applied, so a surface
 *  draws a v2 field exactly as it drew the v1 one. */
export function titleOf(name) {
	return String(name).split(/[_\-\s/]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * The validator's schema. Standard JSON Schema, standard keywords only, no descriptions, no titles:
 * those live once, in `compiled.fields`. Properties are exactly the non-virtual fields.
 */
export function toJsonSchema(fields, { constraints = [], collections } = {}) {
	const properties = {};
	const required = [];
	for (const [name, f] of Object.entries(fields)) {
		if (f.virtual) continue;
		properties[name] = propertySchema(f, collections);
		if (f.required) required.push(name);
	}
	const schema = { type: 'object', properties };
	if (required.length) schema.required = required;
	if (constraints.length) schema.allOf = constraints.map((c) => structuredClone(c));
	return schema;
}

function propertySchema(f, collections) {
	let s = scalarSchema(f, collections);
	for (const k of PASS_THROUGH) if (f[k] !== undefined && !(f.many && ['minItems', 'maxItems'].includes(k))) s[k] = f[k];
	if (f.many) {
		const arr = { type: 'array', items: s };
		for (const k of ['minItems', 'maxItems', 'default', 'examples']) if (f[k] !== undefined) arr[k] = f[k];
		delete s.default; delete s.examples;
		if (f.mirror_of !== undefined) arr.uniqueItems = true;
		s = arr;
	}
	if (f.mirror_of !== undefined) s.readOnly = true;
	return s;
}

function scalarSchema(f, collections) {
	const t = f.type;
	if (referenceTargets(t, collections ?? new Set(Array.isArray(t) ? t : [t]))) return { type: 'string' };
	switch (t) {
		case 'string': return f.enum !== undefined ? { type: 'string', enum: enumValues(f.enum) } : { type: 'string' };
		case 'markdown': return { type: 'string', format: 'markdown' };
		case 'boolean': return { type: 'boolean' };
		case 'integer': return { type: 'integer' };
		case 'number': return { type: 'number' };
		case 'date': return { type: 'string', format: 'date' };
		case 'datetime': return { type: 'string', format: 'date-time' };
		case 'url': return { type: 'string', format: 'uri' };
		case 'email': return { type: 'string', format: 'email' };
		case 'position': return { type: 'string', pattern: '^[a-z]+$' };
		// `values` absent: any value under any key — the open object a free-form block needs
		case 'map': return f.values === undefined ? { type: 'object' } : { type: 'object', additionalProperties: valueSchema(f.values, collections) };
		case 'object': {
			const inner = toJsonSchema(Object.fromEntries(Object.entries(f.fields ?? {}).map(([k, v]) => [k, { ...v, title: undefined }])), { collections });
			return inner;
		}
		default: return { type: 'string' };
	}
}

function valueSchema(values, collections) {
	if (typeof values === 'string') return scalarSchema({ type: values }, collections);
	if (values && typeof values === 'object') return propertySchema(values, collections);
	return {};
}
