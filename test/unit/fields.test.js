// Tier 1 — the descriptor v2 field vocabulary (src/fields.js).
//
// The load-bearing property is the last describe: the validator's schema carries exactly the stored
// fields, type-mapped, and nothing else. If the two ever disagree, a record the surfaces accept is one
// the store refuses (or the reverse), which is the defect this split exists to make impossible.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFields, toJsonSchema, enumValues, enumChoices, referenceTargets, INJECTED_FIELDS, SCALAR_TYPES } from '../../src/fields.js';

const collections = new Set(['health/patients', 'health/doctors', 'health/prescriptions', 'health/referrals', 'health/lab-orders']);
const resolve = (fields) => resolveFields(fields, { name: 'health/visits', collections });

describe('types', () => {
	const cases = [
		['string', { type: 'string' }],
		['markdown', { type: 'string', format: 'markdown' }],
		['boolean', { type: 'boolean' }],
		['integer', { type: 'integer' }],
		['number', { type: 'number' }],
		['date', { type: 'string', format: 'date' }],
		['datetime', { type: 'string', format: 'date-time' }],
		['url', { type: 'string', format: 'uri' }],
		['email', { type: 'string', format: 'email' }],
		['position', { type: 'string', pattern: '^[a-z]+$' }],
		['reference', { type: 'string' }],
		['health/doctors', { type: 'string' }],
	];
	for (const [type, want] of cases) {
		test(`${type} compiles to ${JSON.stringify(want)}`, () => {
			const { fields, errors } = resolve({ f: { type } });
			assert.deepEqual(errors, []);
			assert.deepEqual(toJsonSchema(fields, { collections }).properties.f, want);
		});
	}

	test('position is a string so a fractional key (a-z by design) validates', () => {
		const s = toJsonSchema(resolve({ order: { type: 'position' } }).fields, { collections }).properties.order;
		assert.match('ba', new RegExp(s.pattern));
		assert.doesNotMatch('10', new RegExp(s.pattern));
	});

	test('a union names collections; a non-collection member is an error', () => {
		assert.deepEqual(resolve({ r: { type: ['health/referrals', 'health/lab-orders'] } }).errors, []);
		assert.match(resolve({ r: { type: ['health/referrals', 'nope'] } }).errors.join(), /not all collections|is not a collection/);
	});

	test('an unknown type is an error listing the types', () => {
		assert.match(resolve({ f: { type: 'enum' } }).errors[0], /unknown type "enum"/);
		assert.match(resolve({ f: { type: 'tags' } }).errors[0], /unknown type "tags"/);
		assert.match(resolve({ f: { type: 'text' } }).errors[0], /unknown type "text"/);
	});

	test('referenceTargets: a collection, a union, the polymorphic reference, a scalar', () => {
		assert.deepEqual(referenceTargets('health/doctors', collections), ['health/doctors']);
		assert.deepEqual(referenceTargets(['health/referrals'], collections), ['health/referrals']);
		assert.deepEqual(referenceTargets('reference', collections), ['*']);
		assert.equal(referenceTargets('string', collections), null);
	});

	test('the built-in type names are the documented list', () => {
		assert.deepEqual(SCALAR_TYPES, ['string', 'markdown', 'boolean', 'integer', 'number', 'date', 'datetime', 'url', 'email', 'reference', 'object', 'map', 'position']);
	});
});

describe('keys', () => {
	test('required folds into the schema', () => {
		const s = toJsonSchema(resolve({ a: { type: 'string', required: true }, b: { type: 'string' } }).fields, { collections });
		assert.deepEqual(s.required, ['a']);
	});

	test('many makes an array of the item type, with list keys on the array', () => {
		const s = toJsonSchema(resolve({ t: { type: 'string', many: true, minItems: 1 } }).fields, { collections }).properties.t;
		assert.deepEqual(s, { type: 'array', items: { type: 'string' }, minItems: 1 });
	});

	test('an enum list and an enum map compile to the same value list', () => {
		const list = toJsonSchema(resolve({ k: { type: 'string', enum: ['intake', 'follow-up'] } }).fields, { collections }).properties.k;
		const map = toJsonSchema(resolve({ k: { type: 'string', enum: { intake: { label: 'Intake' }, 'follow-up': { label: 'Follow-up', color: 'charts.green' } } } }).fields, { collections }).properties.k;
		assert.deepEqual(list, { type: 'string', enum: ['intake', 'follow-up'] });
		assert.deepEqual(map, list);
	});

	test('enumChoices keeps the five decoration keys and drops anything else', () => {
		assert.deepEqual(enumChoices({ a: { label: 'A', icon: 'x', junk: 'y' } }), { a: { label: 'A', icon: 'x' } });
		assert.deepEqual(enumChoices(['a']), {});
		assert.deepEqual(enumValues({ a: {}, b: {} }), ['a', 'b']);
	});

	test('a non-kebab enum value warns (renaming it is a record change), and enum belongs to string', () => {
		const r = resolve({ k: { type: 'string', enum: ['CRM'] } });
		assert.deepEqual(r.errors, []);
		assert.match(r.warnings[0], /not kebab-case/);
		assert.deepEqual(resolve({ k: { type: 'string', enum: ['node_modules'], passthrough: true } }).warnings, [], 'a passthrough value keeps its outside spelling');
		assert.match(resolve({ k: { type: 'integer', enum: [1] } }).errors[0], /belongs to type string/);
	});

	test('a non-snake field name warns (renaming it is a record change), a passthrough one does not', () => {
		const r = resolve({ eventId: { type: 'string' } });
		assert.deepEqual(r.errors, []);
		assert.match(r.warnings[0], /names are snake_case/);
		assert.deepEqual(resolve({ 'argument-hint': { type: 'string', passthrough: true } }).warnings, []);
	});

	test('a runtime kind gets no created field — compile writes its records, the store never stamps them', () => {
		const { fields } = resolveFields({ name: { type: 'string' } }, { name: 'skills', collections, runtime: true });
		assert.deepEqual(Object.keys(fields).slice(0, 2), ['id', 'last_modified']);
	});

	test('a key outside the closed list fails naming it', () => {
		assert.match(resolve({ f: { type: 'string', 'x-reference': 'a' } }).errors[0], /unknown key "x-reference"/);
		assert.match(resolve({ f: { type: 'string', searchable: true } }).errors[0], /unknown key "searchable"/);
	});

	test('object with fields and map with values compile to nested schemas', () => {
		const s = toJsonSchema(resolve({
			m: { type: 'object', many: true, item_title: '{{ analyte }}', fields: { analyte: { type: 'string', required: true }, value: { type: 'number' } } },
			codes: { type: 'map', values: 'string' },
		}).fields, { collections }).properties;
		assert.deepEqual(s.m, { type: 'array', items: { type: 'object', properties: { analyte: { type: 'string' }, value: { type: 'number' } }, required: ['analyte'] } });
		assert.deepEqual(s.codes, { type: 'object', additionalProperties: { type: 'string' } });
	});

	test('a mirror is read-only, and a many mirror has unique items', () => {
		const s = toJsonSchema(resolve({ p: { type: 'health/prescriptions', many: true, mirror_of: 'visit' } }).fields, { collections }).properties.p;
		assert.deepEqual(s, { type: 'array', items: { type: 'string' }, uniqueItems: true, readOnly: true });
	});

	test('mirror_of needs one collection, and a mirror is never required', () => {
		assert.match(resolve({ e: { type: 'reference', mirror_of: 'x' } }).errors[0], /exactly one collection/);
		assert.match(resolve({ e: { type: 'health/doctors', mirror_of: 'x', required: true } }).errors[0], /cannot be required/);
	});

	test('on_delete: set-null on a required reference fails; on a scalar it is a reference key', () => {
		assert.match(resolve({ d: { type: 'health/doctors', required: true, on_delete: 'set-null' } }).errors[0], /invalid record/);
		assert.match(resolve({ d: { type: 'string', on_delete: 'restrict' } }).errors[0], /belongs to a reference/);
	});

	test('one body, one position', () => {
		assert.match(resolve({ a: { type: 'markdown', body: true }, b: { type: 'markdown', body: true } }).errors.join(), /one body/);
		assert.match(resolve({ a: { type: 'position' }, b: { type: 'position' } }).errors.join(), /one manual order/);
	});

	test('required with no default and hidden from the form is refused', () => {
		assert.match(resolve({ r: { type: 'string', required: true, display: { hidden: ['form'] } } }).errors[0], /nothing could create a record/);
		assert.deepEqual(resolve({ c: { type: 'string', required: true, default: 'ILS', display: { hidden: ['form'] } } }).errors, []);
	});

	test('display.unit_field names a string field; display keys are closed', () => {
		assert.match(resolve({ fee: { type: 'number', display: { unit: 'currency', unit_field: 'paid' } }, paid: { type: 'boolean' } }).errors[0], /not a string field/);
		assert.match(resolve({ f: { type: 'string', display: { searchable: true } } }).errors[0], /display has unknown key/);
	});

	test('soft belongs to a reference and never to a mirror', () => {
		assert.deepEqual(resolve({ r: { type: ['health/referrals', 'health/lab-orders'], many: true, soft: true } }).errors, []);
		assert.match(resolve({ r: { type: 'string', soft: true } }).errors[0], /`soft` belongs to a reference/);
		assert.match(resolve({ v: { type: 'health/doctors', many: true, mirror_of: 'x', soft: true } }).errors.join(), /cannot be soft/);
	});

	test('derived and virtual exclude each other', () => {
		assert.match(resolve({ f: { type: 'string', derived: true, virtual: true } }).errors[0], /exclude each other/);
	});
});

describe('defaults are recorded apart', () => {
	test('a supplied title and on_delete land in defaults, not as if authored', () => {
		const { fields, defaults } = resolve({ doctor: { type: 'health/doctors' }, reason: { type: 'string', title: 'Reason for visit' } });
		assert.deepEqual(defaults.doctor, { title: 'Doctor', on_delete: 'restrict' });
		assert.equal(defaults.reason, undefined);
		assert.equal(fields.reason.title, 'Reason for visit');
		assert.equal(fields.doctor.on_delete, 'restrict');
	});
});

describe('the three injected fields', () => {
	test('id, created and last_modified come first; only created is stored', () => {
		const { fields } = resolve({ name: { type: 'string' } });
		assert.deepEqual(Object.keys(fields).slice(0, 3), ['id', 'created', 'last_modified']);
		const s = toJsonSchema(fields, { collections });
		assert.ok(s.properties.created);
		assert.equal(s.properties.id, undefined);
		assert.equal(s.properties.last_modified, undefined);
	});

	test('authoring an injected field is an error', () => {
		assert.match(resolve({ created: { type: 'datetime' } }).errors[0], /injected/);
	});
});

describe('json_schema.properties is exactly the stored fields', () => {
	test('on the clinic visit', () => {
		const { fields, errors } = resolve({
			reason: { type: 'string', required: true },
			patient: { type: 'health/patients', required: true },
			date: { type: 'date', required: true },
			kind: { type: 'string', default: 'follow-up', enum: { intake: {}, 'follow-up': {} } },
			measurements: { type: 'object', many: true, fields: { analyte: { type: 'string' } } },
			prescriptions: { type: 'health/prescriptions', many: true, mirror_of: 'visit' },
			position: { type: 'position' },
			notes: { type: 'markdown', body: true },
		});
		assert.deepEqual(errors, []);
		const stored = Object.entries(fields).filter(([, f]) => !f.virtual).map(([k]) => k);
		assert.deepEqual(Object.keys(toJsonSchema(fields, { collections }).properties), stored);
		assert.ok(!stored.includes('id') && !stored.includes('last_modified'));
		assert.equal(Object.keys(INJECTED_FIELDS).length, 3);
	});

	test('constraints concatenate under allOf, copied, never aliased', () => {
		const c = [{ if: { required: ['status'], properties: { status: { const: 'seen' } } }, then: { required: ['duration_min'] } }];
		const s = toJsonSchema(resolve({ status: { type: 'string' } }).fields, { constraints: c, collections });
		assert.deepEqual(s.allOf, c);
		assert.notEqual(s.allOf[0], c[0]);
	});
});

describe('a definition nested in an object or a map is held to the same vocabulary', () => {
	const errs = (fields) => resolve(fields).errors;
	test('an unknown type and an unknown key, each under its full path', () => {
		assert.match(errs({ details: { type: 'object', fields: { code: { type: 'strnig' } } } }).join('\n'), /field "details\.code": unknown type "strnig"/);
		assert.match(errs({ details: { type: 'object', fields: { code: { type: 'string', patern: '^[a-z]+$' } } } }).join('\n'), /field "details\.code" has unknown key "patern"/);
		assert.match(errs({ scores: { type: 'map', values: { type: 'integr' } } }).join('\n'), /field "scores\.values": unknown type "integr"/);
		assert.match(errs({ scores: { type: 'map', values: 'nmber' } }).join('\n'), /field "scores": `values` names unknown type "nmber"/);
	});
	test('a malformed nested display, and a record-level key where no record is', () => {
		assert.match(errs({ details: { type: 'object', fields: { code: { type: 'string', display: { widht: 'narrow' } } } } }).join('\n'), /field "details\.code": display has unknown key "widht"/);
		assert.match(errs({ details: { type: 'object', fields: { code: { type: 'string', unique: true } } } }).join('\n'), /field "details\.code": `unique` belongs to a collection's own field/);
	});
	test('valid deep nesting resolves, with no injected field inside it', () => {
		const r = resolve({ address: { type: 'object', fields: { geo: { type: 'object', fields: { lat: { type: 'number', minimum: -90 }, tags: { type: 'string', many: true, pattern: '^[a-z]+$' } } }, extra: { type: 'map', values: { type: 'object', fields: { note: { type: 'string' } } } } } } });
		assert.deepEqual(r.errors, []);
		assert.deepEqual(Object.keys(r.fields.address.fields), ['geo', 'extra']);
	});
});
