// Tier 2 — descriptor format v2 reaching a real compile, store and check.
//
// The synthetic clinic from the design's worked example, cut down to what each assertion needs:
// `health/patients` (folder records), `health/doctors`, `health/visits` stored under its patient,
// a mixin, and an overlay from a second module adding a cross-module mirror. Invented names only —
// this engine is published.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, writeCollection, writeModule, compileError, compileQuietly, dt, WS_MODULE } from '../helpers/ws.js';
import { load, dump } from '../../src/yaml.js';

const PATIENTS = {
	description: 'A person under this clinic\'s care.',
	storage: { shape: 'folder', entry: 'patient.md' },
	ids: { from: '{{ name | slug }}' },
	fields: {
		name: { type: 'string', required: true },
		national_id: { type: 'string', unique: true, pattern: '^\\d{9}$', display: { editable: 'create' } },
		visits: { type: 'health/visits', many: true, mirror_of: 'patient', description: 'Every visit. Set `patient` on the visit.' },
		notes: { type: 'markdown', body: true },
	},
};
const DOCTORS = {
	description: 'A doctor.',
	ids: { from: '{{ name | slug }}' },
	fields: { name: { type: 'string', required: true }, notes: { type: 'markdown', body: true } },
};
const VISITS = {
	description: 'One consultation between a patient and a doctor.',
	record_title: '{{ reason }} · {{ date }}',
	storage: { under: { parent: 'patient', subfolder: 'visits' } },
	ids: { from: '{{ date | date }}--{{ patient | basename }}--{{ doctor | basename }}', pattern: '^\\d{4}-\\d{2}-\\d{2}--[a-z0-9-]+--[a-z0-9-]+$' },
	mixins: ['clinic-provenance'],
	fields: {
		reason: { type: 'string', required: true, title: 'Reason for visit' },
		patient: { type: 'health/patients', required: true },
		doctor: { type: 'health/doctors', required: true },
		date: { type: 'date', required: true },
		kind: { type: 'string', default: 'follow-up', enum: { intake: { label: 'Intake', color: 'charts.blue' }, 'follow-up': { label: 'Follow-up' } } },
		status: { type: 'string', default: 'booked', enum: ['booked', 'seen', 'cancelled'] },
		duration_min: { type: 'integer', minimum: 5, display: { unit: 'min' } },
		paid: { type: 'boolean', default: false },
		measurements: { type: 'object', many: true, item_title: '{{ analyte }}', fields: { analyte: { type: 'string', required: true }, value: { type: 'number' } } },
		codes: { type: 'map', values: 'string' },
		evidence: { type: 'reference', many: true },
		position: { type: 'position' },
		consultation_notes: { type: 'markdown', body: true },
	},
	constraints: [
		{ if: { required: ['status'], properties: { status: { const: 'seen' } } }, then: { required: ['duration_min'] } },
	],
	display: {
		nav: { icon: 'pulse', order: 20, section: 'care' },
		list: { columns: ['reason', 'patient', 'date', 'status'], sort: '-date' },
		record: { subtitle: '{{ patient }} · {{ kind }}', badge: 'status', color_by: 'kind' },
		form: { sections: [{ title: 'Visit', fields: ['reason', 'patient', 'doctor', 'date', 'kind', 'status'] }] },
	},
};
const MIXIN = {
	name: 'clinic-provenance',
	description: 'Who made the record, and how much to trust it.',
	use_when: 'every clinic collection an agent may write',
	fields: { author: { type: 'string' }, confidence: { type: 'string', default: 'normal', enum: ['low', 'normal', 'high'] } },
};

function clinic({ visits = VISITS, extra } = {}) {
	const w = workspace({ namespaces: ['health'], compile: false });
	writeCollection(w.root, 'health/patients', PATIENTS);
	writeCollection(w.root, 'health/doctors', DOCTORS);
	writeCollection(w.root, 'health/visits', visits);
	const mixins = path.join(w.root, 'modules', WS_MODULE, 'mixins');
	fs.mkdirSync(mixins, { recursive: true });
	fs.writeFileSync(path.join(mixins, 'clinic-provenance.mixin.yaml'), dump(MIXIN));
	extra?.(w.root);
	return w;
}
const compiled = (root, name) => load(fs.readFileSync(path.join(root, '.dreamteamer', 'collections', `${name}.collection.yaml`), 'utf8'));

describe('a v2 descriptor compiles', () => {
	test('the clinic compiles and the visit carries a compiled block', () => {
		const w = clinic();
		assert.equal(compileError(w.ws), null);
		const d = compiled(w.root, 'health/visits');
		assert.ok(d.compiled, 'compiled block present');
		assert.deepEqual(d.compiled.mirrors, []);
		assert.equal(d.compiled.under_collection, 'health/patients');
		assert.equal(d.compiled.runtime, false);
		assert.deepEqual(Object.keys(d.compiled.fields).slice(0, 3), ['id', 'created', 'last_modified']);
		// the mixin's fields land before the body
		const keys = Object.keys(d.compiled.fields);
		assert.ok(keys.indexOf('author') < keys.indexOf('consultation_notes'));
		assert.ok(keys.indexOf('confidence') > keys.indexOf('position'));
	});

	test('json_schema.properties is exactly the stored fields, and carries no x- keyword', () => {
		const w = clinic();
		compileQuietly(w.ws);
		const d = compiled(w.root, 'health/visits');
		const stored = Object.entries(d.compiled.fields).filter(([, f]) => !f.virtual).map(([k]) => k);
		assert.deepEqual(Object.keys(d.compiled.json_schema.properties), stored);
		assert.doesNotMatch(JSON.stringify(d.compiled.json_schema), /"x-/);
		assert.deepEqual(d.compiled.json_schema.required, ['reason', 'patient', 'doctor', 'date']);
		assert.equal(d.compiled.json_schema.allOf.length, 1);
		assert.deepEqual(d.compiled.json_schema.properties.position, { type: 'string', pattern: '^[a-z]+$' });
	});

	test('defaults are recorded apart: title, singular, storage, field titles and on_delete', () => {
		const w = clinic();
		compileQuietly(w.ws);
		const d = compiled(w.root, 'health/visits');
		assert.equal(d.compiled.defaults.title, 'Visits');
		assert.equal(d.compiled.defaults.singular, 'health/visit');
		assert.equal(d.compiled.defaults.record_title, undefined, 'record_title was authored');
		assert.deepEqual(d.compiled.defaults.storage, { path: 'data/health/visits', format: 'md', shape: 'file', suffix: 'visit' });
		assert.deepEqual(d.compiled.defaults.fields.doctor, { title: 'Doctor', on_delete: 'restrict' });
		assert.equal(d.compiled.defaults.fields.reason, undefined, 'reason authored its title');
	});

	test('the patient mirror resolves and the display block rides along', () => {
		const w = clinic();
		compileQuietly(w.ws);
		assert.deepEqual(compiled(w.root, 'health/patients').compiled.mirrors, ['visits']);
		assert.equal(compiled(w.root, 'health/visits').display.record.badge, 'status');
	});

	test('the mixins meta-descriptor is itself v2 and compiles', () => {
		const w = clinic();
		compileQuietly(w.ws);
		const m = compiled(w.root, 'mixins');
		assert.equal(m.compiled.runtime, true);
		assert.ok(m.compiled.fields.fields);
	});
});

describe('a v2 descriptor is refused, with the fix in the message', () => {
	const refuse = (patch, re) => {
		const w = clinic({ visits: { ...VISITS, ...patch } });
		const err = compileError(w.ws);
		assert.ok(err, 'expected a compile error');
		assert.match(err, re);
	};
	test('a key outside the v2 shape is unknown, naming the keys there are', () => {
		refuse({ list_fields: ['reason'] }, /unknown key `list_fields` — a descriptor's keys are name · title/);
		refuse({ storage: { codec: 'md' } }, /unknown key `storage.codec` — storage keys are path · format/);
	});
	test('an unknown filter in a template names the position', () => {
		refuse({ record_title: '{{ reason | title }}' }, /record_title: unknown filter "title"/);
	});
	test('record_title opening with a non-string field', () => {
		refuse({ record_title: '{{ date }} · {{ reason }}' }, /record_title opens with "date", a date field/);
	});
	test('a column naming no field', () => {
		refuse({ display: { list: { columns: ['nope'] } } }, /display.list.columns names "nope"/);
	});
	test('a field hidden from the form but listed in a section', () => {
		refuse({
			fields: { ...VISITS.fields, paid: { type: 'boolean', default: false, display: { hidden: ['form'] } } },
			display: { form: { sections: [{ title: 'Billing', fields: ['paid'] }] } },
		}, /lists "paid", which is hidden from the form/);
	});
	test('a mixin field colliding with an authored one', () => {
		refuse({ fields: { ...VISITS.fields, author: { type: 'string' } } }, /field "author" is declared by the descriptor and by mixin "clinic-provenance"/);
	});
	test('a type naming no collection', () => {
		refuse({ fields: { ...VISITS.fields, nurse: { type: 'health/nurses' } } }, /unknown type "health\/nurses"/);
	});
	test('a v1 source is refused with the one message naming the converter', () => {
		const w = clinic({
			extra: (root) => writeModule(root, 'billing', { dependencies: [WS_MODULE], collections: { 'health/visits': { extends: `${WS_MODULE}/health/visits`, schema: { properties: { claim: { type: 'string' } } } } } }),
		});
		const err = compileError(w.ws);
		assert.match(err, /1 source\(s\) are in the v1 descriptor format, which this engine no longer reads/);
		assert.match(err, /modules\/billing\/collections\/health\/visits\.collection\.yaml/);
		assert.match(err, /migrate-descriptors-v2\.mjs --root \./);
		assert.match(err, /UPDATING\.md/);
	});
});

describe('an overlay from another module', () => {
	test('adds a field and is listed in overlaid_by', () => {
		const w = clinic({
			extra: (root) => writeModule(root, 'billing', { dependencies: [WS_MODULE], collections: { 'health/visits': { overlay: true, fields: { claim_ref: { type: 'string', description: 'The insurer claim number.' } } } } }),
		});
		assert.equal(compileError(w.ws), null);
		const d = compiled(w.root, 'health/visits');
		assert.deepEqual(d.compiled.overlaid_by, ['billing']);
		assert.ok(d.compiled.fields.claim_ref);
		const keys = Object.keys(d.compiled.fields);
		assert.ok(keys.indexOf('claim_ref') < keys.indexOf('consultation_notes'), 'the overlay field sits before the body');
	});
	test('without the dependency on the base module it is refused', () => {
		const w = clinic({
			extra: (root) => writeModule(root, 'billing', { collections: { 'health/visits': { overlay: true, fields: { claim_ref: { type: 'string' } } } } }),
		});
		assert.match(compileError(w.ws), /module "billing" neither depends on "default" nor declares "health\/visits" in peer_collections/);
	});
});

describe('records against a v2 collection', () => {
	test('add, list and check through the real CLI', () => {
		const w = clinic();
		compileQuietly(w.ws);
		assert.equal(dt(w.root, 'add', 'health/doctors', '--name', 'Dr Cohen').code, 0);
		assert.equal(dt(w.root, 'add', 'health/patients', '--name', 'Dana Levi').code, 0);
		const add = dt(w.root, 'add', 'health/visit', 'Checkup', '--patient', 'health/patients/dana-levi', '--doctor', 'health/doctors/dr-cohen', '--date', '2026-03-04', '--status', 'booked');
		assert.equal(add.code, 0, add.stderr);
		assert.ok(fs.existsSync(path.join(w.root, 'data', 'health', 'patients', 'dana-levi', 'visits', '2026-03-04--dana-levi--dr-cohen.visit.md')), 'stored under its patient');
		const bad = dt(w.root, 'add', 'health/visit', 'Seen', '--patient', 'health/patients/dana-levi', '--doctor', 'health/doctors/dr-cohen', '--date', '2026-03-05', '--status', 'seen');
		assert.notEqual(bad.code, 0, 'a seen visit without duration_min violates the constraint');
		const check = dt(w.root, 'check');
		assert.equal(check.code, 0, check.stdout + check.stderr);
	});
});

describe('the store and check read compiled.fields', () => {
	const ready = (visits = VISITS) => {
		const w = clinic({ visits });
		compileQuietly(w.ws);
		dt(w.root, 'add', 'health/doctors', '--name', 'Dr Cohen');
		dt(w.root, 'add', 'health/patients', '--name', 'Dana Levi', '--national_id', '123456789');
		return w;
	};
	const visit = (w, ...extra) => dt(w.root, 'add', 'health/visit', 'Checkup', '--patient', 'health/patients/dana-levi', '--doctor', 'health/doctors/dr-cohen', '--date', '2026-03-04', ...extra);

	test('created is stamped at add with a local offset, and refused from a writer', () => {
		const w = ready();
		assert.equal(visit(w).code, 0);
		const text = fs.readFileSync(path.join(w.root, 'data', 'health', 'patients', 'dana-levi', 'visits', '2026-03-04--dana-levi--dr-cohen.visit.md'), 'utf8');
		assert.match(text, /^created: '?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}'?$/m);
		const forged = visit(w, '--created', '2020-01-01T00:00:00Z', '--id', 'forged');
		assert.notEqual(forged.code, 0);
		assert.match(forged.stderr, /created is written by the engine/);
		const set = dt(w.root, 'set', 'health/visits/2026-03-04--dana-levi--dr-cohen', 'created=2020-01-01T00:00:00Z');
		assert.notEqual(set.code, 0);
		assert.match(set.stderr, /created is written by the engine/);
	});

	test('ids.from naming created reads the stamp', () => {
		const w = workspace({ compile: false });
		writeCollection(w.root, 'notes', { ids: { from: '{{ created | date }}--{{ name | slug }}' }, fields: { name: { type: 'string', required: true }, body: { type: 'markdown', body: true } } });
		compileQuietly(w.ws);
		const add = dt(w.root, 'add', 'note', 'First', '--json');
		assert.equal(add.code, 0, add.stderr);
		const today = new Date();
		const p = (n) => String(n).padStart(2, '0');
		assert.equal(JSON.parse(add.stdout).id, `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}--first`);
	});

	test('a unique value is refused at write and named by check', () => {
		const w = ready();
		const dup = dt(w.root, 'add', 'health/patients', '--name', 'Dan Levy', '--national_id', '123456789');
		assert.notEqual(dup.code, 0);
		assert.match(dup.stderr, /national_id: "123456789" is already taken by health\/patients\/dana-levi \(unique\)/);
		// a hand-edited duplicate reaches disk; check is where it is reported
		dt(w.root, 'add', 'health/patients', '--name', 'Dan Levy', '--national_id', '987654321');
		const f = path.join(w.root, 'data', 'health', 'patients', 'dan-levy', 'patient.md');
		fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('987654321', '123456789'));
		const check = dt(w.root, 'check');
		assert.notEqual(check.code, 0);
		assert.match(check.stdout + check.stderr, /national_id: "123456789" is already taken by health\/patients\/(dana-levi|dan-levy) \(unique\)/);
	});

	test('a deprecated field still validates and warns on add', () => {
		const w = ready({ ...VISITS, fields: { ...VISITS.fields, legacy_code: { type: 'string', deprecated: true } } });
		const add = visit(w, '--legacy_code', 'A1');
		assert.equal(add.code, 0, add.stderr);
		assert.match(add.stderr, /legacy_code is deprecated on health\/visits/);
	});
});

describe('created for a record that predates the stamp', () => {
	const unstamp = (file) => fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^created: .*\n/m, ''));

	test('read from the id when ids are made from created', () => {
		const w = workspace({ compile: false });
		writeCollection(w.root, 'notes', { ids: { from: '{{ created | date }}--{{ name | slug }}' }, fields: { name: { type: 'string', required: true }, body: { type: 'markdown', body: true } } });
		compileQuietly(w.ws);
		fs.mkdirSync(path.join(w.root, 'data', 'notes'), { recursive: true });
		fs.writeFileSync(path.join(w.root, 'data', 'notes', '2024-05-06--old.note.md'), '---\nname: Old\n---\n');
		const got = dt(w.root, 'get', 'notes/2024-05-06--old', '--json');
		assert.equal(got.code, 0, got.stderr);
		assert.match(JSON.parse(got.stdout).created, /^2024-05-06T00:00:00[+-]\d{2}:\d{2}$/);
	});

	test('undefined while no commit holds the record', () => {
		const w = workspace({ compile: false });
		writeCollection(w.root, 'notes', { ids: { from: '{{ name | slug }}' }, fields: { name: { type: 'string', required: true }, body: { type: 'markdown', body: true } } });
		compileQuietly(w.ws);
		dt(w.root, 'add', 'note', 'Fresh');
		const file = path.join(w.root, 'data', 'notes', 'fresh.note.md');
		unstamp(file);
		assert.equal(JSON.parse(dt(w.root, 'get', 'notes/fresh', '--json').stdout).created, undefined);
	});

	test('read from the first commit otherwise, and the file is not rewritten', () => {
		const w = workspace({ compile: false });
		writeCollection(w.root, 'notes', { ids: { from: '{{ name | slug }}' }, fields: { name: { type: 'string', required: true }, body: { type: 'markdown', body: true } } });
		compileQuietly(w.ws);
		assert.equal(dt(w.root, 'add', 'note', 'Kept').code, 0);
		// a write does not commit; the fallback reads the FIRST COMMIT, so publish it first
		assert.equal(dt(w.root, 'commit', 'notes/kept').code, 0);
		const file = path.join(w.root, 'data', 'notes', 'kept.note.md');
		unstamp(file);
		const before = fs.readFileSync(file, 'utf8');
		const got = JSON.parse(dt(w.root, 'get', 'notes/kept', '--json').stdout);
		assert.match(got.created, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
		assert.equal(fs.readFileSync(file, 'utf8'), before, 'reading never writes');
	});
});

describe('the display contract', () => {
	test('created and an editable:false field are readonly in the display contract', async () => {
		const { presentation } = await import('../../src/presentation.js');
		const { loadDescriptors } = await import('../../src/runtime.js');
		const w = clinic();
		compileQuietly(w.ws);
		const p = presentation(loadDescriptors(w.root));
		const row = (c, f) => p.fields[c].find((r) => r.field === f);
		assert.equal(row('health/visits', 'created').meta.readonly, true);
		assert.equal(row('health/visits', 'reason').meta.readonly, undefined);
		const locked = clinic({ visits: { ...VISITS, fields: { ...VISITS.fields, summary_url: { type: 'url', display: { editable: false } } } } });
		compileQuietly(locked.ws);
		const q = presentation(loadDescriptors(locked.root));
		assert.equal(q.fields['health/visits'].find((r) => r.field === 'summary_url').meta.readonly, true);
	});
});

describe('item constraints on a list reach the store and check (review R3)', () => {
	const NOTES = {
		description: 'A note.',
		ids: { from: '{{ name | slug }}' },
		fields: {
			name: { type: 'string', required: true },
			tags: { type: 'string', many: true, pattern: '^[a-z][a-z0-9-]*$' },
			scores: { type: 'integer', many: true, minimum: 1, maximum: 5 },
			codes: { type: 'string', many: true, minLength: 2, maxLength: 3 },
			marks: { type: 'string', many: true, const: 'x' },
			position: { type: 'position' },
			body: { type: 'markdown', body: true },
		},
	};
	const ready = () => {
		const w = workspace({ compile: false });
		writeCollection(w.root, 'notes', NOTES);
		compileQuietly(w.ws);
		return w;
	};
	const bad = [
		['tags', 'INVALID', /tags/],
		['scores', '9', /scores/],
		['codes', 'abcdef', /codes/],
		['marks', 'y', /marks/],
		['position', '123!', /position/],
	];
	for (const [field, value, re] of bad) {
		test(`store.add refuses ${field}=${value}`, () => {
			const w = ready();
			const r = dt(w.root, 'add', 'note', `Bad ${field}`, `--${field}`, value);
			assert.notEqual(r.code, 0, `${field}=${value} was accepted`);
			assert.match(r.stderr, re);
		});
	}
	test('valid values pass add and check', () => {
		const w = ready();
		const r = dt(w.root, 'add', 'note', 'Good', '--tags', 'alpha', '--scores', '3', '--codes', 'ab', '--marks', 'x', '--position', 'm');
		assert.equal(r.code, 0, r.stderr);
		assert.equal(dt(w.root, 'check').code, 0);
	});
	test('check reports a hand-edited bad item and a bad position', () => {
		const w = ready();
		fs.mkdirSync(path.join(w.root, 'data', 'notes'), { recursive: true });
		fs.writeFileSync(path.join(w.root, 'data', 'notes', 'hand.note.md'), "---\nname: Hand\ntags:\n  - INVALID\nposition: '123!'\n---\n");
		const c = dt(w.root, 'check');
		assert.notEqual(c.code, 0);
		assert.match(c.stdout + c.stderr, /tags/);
		assert.match(c.stdout + c.stderr, /position/);
	});
});
