// Tier 1 — what the display contract SAYS about each collection and field, read from the compiled v2
// shape alone, through the `src/descriptor.js` accessors (authored keys over `compiled.defaults`,
// `compiled.fields`). The clinic fixture is the design's worked example in compiled form.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { presentation } from '../../src/presentation.js';
import { clinic, compiledCollection } from '../helpers/clinic-compiled.js';

const p = presentation(clinic());
const collection = (name) => p.collections.find((c) => c.collection === name);
const field = (c, f) => p.fields[c].find((r) => r.field === f);

describe('a collection row', () => {
	test('visits: every key from its authored display and compiled defaults', () => {
		assert.deepEqual(collection('health/visits'), {
			collection: 'health/visits',
			title: 'Visits',
			nav: { icon: 'stethoscope', order: 20, section: 'care' },
			// contact_email is deprecated: drawn nowhere, so not a column either
			list: { layout: 'table', columns: ['reason', 'patient', 'date', 'doctor', 'kind', 'status', 'fee'], sort: '-date', options: { page_size: 50 } },
			record: { layout: 'page', subtitle: '{{ patient }} · {{ kind }}', badge: 'status', color_by: 'kind', options: { relation_views: { prescriptions: 'table' } } },
			form: {
				sections: [
					{ title: 'Visit', fields: ['reason', 'patient', 'doctor', 'date', 'checked_in', 'kind', 'status'] },
					{ title: 'Findings', fields: ['measurements', 'diagnosis_codes', 'prescriptions', 'referral', 'evidence'] },
					// intake_code names the section from its own display.form_section
					{ title: 'Billing', fields: ['duration_min', 'fee', 'paid', 'invoice', 'intake_code'] },
				],
			},
			position_field: 'position',
			record_title: '{{ reason }} · {{ date }}',
			record_type: 'visit',
			runtime: false,
			internal: false,
		});
	});

	test('what compile supplied comes from compiled.defaults', () => {
		const row = collection('health/patients');
		assert.equal(row.title, 'Patients');
		assert.equal(row.record_title, '{{ name }}');
		assert.equal(row.record_type, 'patient');
		assert.deepEqual(row.list, { layout: 'table' });
		assert.deepEqual(row.record, { layout: 'page' });
		assert.deepEqual(row.form, { sections: [] });
		assert.equal(row.position_field, undefined);
	});

	test('an authored layout wins over the default', () => {
		const d = compiledCollection('boards', { authored: { display: { list: { layout: 'kanban', options: { lanes_by: 'lane' } }, record: { layout: 'data-model' } } } });
		const row = presentation(new Map([['boards', d]])).collections[0];
		assert.deepEqual(row.list, { layout: 'kanban', options: { lanes_by: 'lane' } });
		assert.deepEqual(row.record, { layout: 'data-model' });
	});

	test('the default layouts hold where compiled.defaults states none', () => {
		const d = compiledCollection('notes', { defaults: { display: undefined } });
		const row = presentation(new Map([['notes', d]])).collections[0];
		assert.equal(row.list.layout, 'table');
		assert.equal(row.record.layout, 'page');
	});

	test('collections come in nav order, unordered last', () => {
		assert.deepEqual(p.collections.map((c) => c.collection).slice(0, 2), ['health/patients', 'health/visits']);
	});
});

describe('a field row', () => {
	test('the three injected fields', () => {
		assert.deepEqual(p.fields['health/visits'].slice(0, 3).map(({ description, ...r }) => r), [
			{ collection: 'health/visits', field: 'id', type: 'string', title: 'Id', required: false, kind: 'virtual', editable: false, hidden: ['list', 'form', 'record'], nullable: true },
			{ collection: 'health/visits', field: 'created', type: 'datetime', title: 'Created', required: false, kind: 'derived', editable: false, hidden: ['form'], nullable: true },
			{ collection: 'health/visits', field: 'last_modified', type: 'datetime', title: 'Last Modified', required: false, kind: 'virtual', editable: false, hidden: ['form'], nullable: true },
		]);
	});

	test('a plain authored field, every display key', () => {
		assert.deepEqual(field('health/visits', 'reason'), {
			collection: 'health/visits', field: 'reason', type: 'string', title: 'Reason for visit', description: 'In the patient\'s own words.',
			required: true, editable: true, nullable: false, placeholder: 'Reason in the patient\'s words', direction: 'rtl', form_section: 'Visit',
		});
		assert.deepEqual(field('health/visits', 'fee'), {
			collection: 'health/visits', field: 'fee', type: 'number', title: 'Fee', required: false, editable: true,
			editor: 'money-input', editor_options: { precision: 2 }, viewer: 'money', viewer_options: { precision: 2 },
			nullable: true, unit: 'currency', unit_field: 'currency', form_section: 'Billing',
		});
	});

	test('read-only is carried by kind and editable (created, virtual, mirror, display.editable)', () => {
		assert.equal(field('health/visits', 'created').editable, false);
		assert.equal(field('health/visits', 'prescriptions').kind, 'mirror');
		assert.equal(field('health/visits', 'prescriptions').editable, false);
		assert.equal(field('health/visits', 'summary_url').kind, undefined, 'a UI lock is not an engine kind');
		assert.equal(field('health/visits', 'summary_url').editable, false);
		assert.equal(field('health/visits', 'intake_code').editable, 'create');
		assert.equal(field('health/visits', 'reason').editable, true);
	});

	test('role names the shape: body, reference, reference_many, mirror', () => {
		assert.equal(field('health/visits', 'consultation_notes').role, 'body');
		assert.equal(field('health/visits', 'consultation_notes').type, 'markdown');
		assert.equal(field('health/visits', 'patient').role, 'reference');
		assert.equal(field('health/visits', 'referral').role, 'reference', 'a union is a scalar reference');
		assert.equal(field('health/visits', 'evidence').role, 'reference_many', 'a polymorphic list is a reference list');
		assert.equal(field('health/visits', 'prescriptions').role, 'mirror');
		assert.equal(field('health/visits', 'prescriptions').mirror_of, 'visit');
		assert.equal(field('health/visits', 'date').role, undefined);
		for (const f of ['patient', 'referral', 'evidence', 'prescriptions']) assert.equal(field('health/visits', f).type, 'string', `${f} travels as a string`);
	});

	test('relation facts: on_delete on an owner, unique, nullable and default', () => {
		assert.equal(field('health/visits', 'doctor').on_delete, 'restrict');
		assert.equal(field('health/visits', 'referral').on_delete, 'set-null');
		assert.equal(field('health/visits', 'prescriptions').on_delete, undefined, 'a mirror has no delete policy of its own');
		assert.equal(field('health/visits', 'invoice').unique, true);
		assert.equal(field('health/visits', 'kind').nullable, false);
		assert.equal(field('health/visits', 'kind').default, 'follow-up');
		assert.equal(field('health/visits', 'paid').default, false);
	});

	test('hidden lists where a field is not drawn; a deprecated field is drawn nowhere', () => {
		assert.deepEqual(field('health/visits', 'checked_in').hidden, ['list']);
		assert.deepEqual(field('health/visits', 'currency').hidden, ['list', 'form']);
		const gone = field('health/visits', 'contact_email');
		assert.deepEqual(gone.hidden, ['list', 'form', 'record']);
		assert.equal(gone.deprecated, true);
		assert.equal(gone.sensitive, true);
		assert.equal(gone.form_section, undefined);
	});

	test('a many object carries its sub-fields and row label in its component options', () => {
		const m = field('health/visits', 'measurements');
		assert.equal(m.type, 'object');
		assert.equal(m.many, true);
		assert.equal(m.editor_options.item_title, '{{ analyte }} {{ value }} {{ unit }}');
		assert.deepEqual(m.editor_options.fields.map((s) => [s.field, s.type, s.required]), [['analyte', 'string', true], ['value', 'number', true], ['unit', 'string', false]]);
		assert.equal(field('health/visits', 'diagnosis_codes').type, 'map');
		assert.equal(field('health/visits', 'position').type, 'position');
	});

	test('the unit and width hints pass through', () => {
		const d = field('health/visits', 'duration_min');
		assert.equal(d.unit, 'min');
		assert.equal(d.width, 6);
		assert.equal(d.type, 'integer');
	});
});

describe('relations', () => {
	const rel = (c, f) => p.relations.filter((r) => r.collection === c && r.field === f);

	test('kind is the owner\'s cardinality from many + unique, and only where a mirror exists', () => {
		assert.deepEqual(rel('health/prescriptions', 'visit'), [{ collection: 'health/prescriptions', field: 'visit', related_collection: 'health/visits', list: false, kind: 'm2o' }]);
		assert.deepEqual(rel('billing/claims', 'visit'), [{ collection: 'billing/claims', field: 'visit', related_collection: 'health/visits', list: false, kind: 'o2o' }]);
		assert.deepEqual(rel('health/patients', 'doctors'), [{ collection: 'health/patients', field: 'doctors', related_collection: 'health/doctors', list: true, kind: 'm2m' }]);
		assert.deepEqual(rel('health/visits', 'doctor'), [{ collection: 'health/visits', field: 'doctor', related_collection: 'health/doctors', list: false }], 'no mirror, no relation kind');
	});

	test('a mirror is flagged rather than typed', () => {
		assert.deepEqual(rel('health/visits', 'prescriptions'), [{ collection: 'health/visits', field: 'prescriptions', related_collection: 'health/prescriptions', list: true, mirror: true }]);
		assert.deepEqual(rel('health/visits', 'insurer_claim'), [{ collection: 'health/visits', field: 'insurer_claim', related_collection: 'billing/claims', list: false, mirror: true }]);
	});

	test('a union has a row per member; a polymorphic reference has none', () => {
		assert.deepEqual(rel('health/visits', 'referral').map((r) => r.related_collection), ['health/referrals', 'health/lab-orders']);
		assert.deepEqual(rel('health/visits', 'evidence'), []);
	});
});

describe('only the v2 shape is read', () => {
	test('a descriptor carrying only v1 keys projects none of them', () => {
		const v1 = {
			name: 'legacy',
			icon: 'book', order: 1, group: 'system', list_fields: ['name'], sort_field: 'rank', title_template: '{{ name }}',
			storage: { path: 'data/legacy', base: 'runtime', codec: 'md' },
			schema: { type: 'object', properties: { name: { type: 'string', 'x-body': true } } },
		};
		const q = presentation(new Map([['legacy', v1]]));
		assert.deepEqual(q.fields.legacy, [], 'no compiled.fields, no field rows — schema.properties is never read');
		const row = q.collections[0];
		assert.deepEqual(row.nav, {}, 'icon and order are display.nav keys');
		assert.deepEqual(row.list, { layout: 'table' }, 'list_fields is not a column list');
		assert.equal(row.record_title, '{{ id }}', 'title_template is not record_title — the accessor\'s default stands');
		assert.equal(row.position_field, undefined, 'sort_field is not a position field');
		assert.equal(row.runtime, false, 'storage.base is not compiled.runtime');
		assert.equal(row.internal, false, 'group: system is not internal');
	});
});

describe('the contract reads through src/descriptor.js, so compile\'s defaults count wherever the author was silent', () => {
	// Nothing authored but the name: every collection-level value below can only have come from
	// `compiled.defaults`, resolved by the same accessors the store and check use.
	const bare = compiledCollection('health/rooms', {
		defaults: {
			title: 'Rooms',
			record_title: '{{ label }}',
			storage: { path: 'data/health/rooms', format: 'md', shape: 'file', suffix: 'room' },
			display: { nav: { icon: 'home', order: 5 }, list: { layout: 'cards', columns: ['label'] }, record: { layout: 'panel', badge: 'label' } },
		},
		fields: { label: { type: 'string', required: true, title: 'Label' } },
	});
	const row = presentation(new Map([[bare.name, bare]])).collections[0];

	test('title, record_title and record_type come from the defaults (titleOf, recordTitleOf, storageOf)', () => {
		assert.equal(row.title, 'Rooms');
		assert.equal(row.record_title, '{{ label }}');
		assert.equal(row.record_type, 'room');
	});

	test('a display default compile supplied is drawn like an authored one (displayOf)', () => {
		assert.deepEqual(row.nav, { icon: 'home', order: 5 });
		assert.deepEqual(row.list, { layout: 'cards', columns: ['label'] });
		assert.deepEqual(row.record, { layout: 'panel', badge: 'label' });
	});

	test('an authored display key wins over the default under it', () => {
		const authored = structuredClone(bare);
		authored.display = { nav: { icon: 'door' }, list: { layout: 'table' } };
		const r = presentation(new Map([[authored.name, authored]])).collections[0];
		assert.deepEqual(r.nav, { icon: 'door', order: 5 });
		assert.deepEqual(r.list, { layout: 'table', columns: ['label'] });
	});

	test('with no title in either place the collection is titled by its name, and the record by its id', () => {
		const none = compiledCollection('health/beds', { defaults: { title: undefined } });
		const r = presentation(new Map([[none.name, none]])).collections[0];
		assert.equal(r.title, 'health/beds');
		assert.equal(r.record_title, '{{ id }}');
	});
});

describe('a collection row carries what surfaces read from its display', () => {
	const notes = compiledCollection('notes', {
		authored: { display: { record: { options: { relation_views: { links: 'table' } } } } },
		fields: {
			name: { type: 'string', title: 'Name', display: { form_section: 'Basics' } },
			cost: { type: 'number', title: 'Cost', display: { form_section: 'Money' } },
			when: { type: 'date', title: 'When', display: { form_section: 'Basics' } },
		},
	});
	const row = presentation(new Map([['notes', notes]])).collections.find((c) => c.collection === 'notes');
	test("display.record.options reaches the row, as display.list.options does", () => {
		assert.deepEqual(row.record.options, { relation_views: { links: 'table' } });
	});
	test('a section only fields name is a section, in the order its first field comes', () => {
		assert.deepEqual(row.form.sections, [{ title: 'Basics', fields: ['name', 'when'] }, { title: 'Money', fields: ['cost'] }]);
	});
});
