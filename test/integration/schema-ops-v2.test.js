// Tier 2 — the schema verbs writing descriptor format v2, through the real CLI and compile gate.
//
// The synthetic clinic: `health/patients` (folder records, a mirror of every visit), `health/doctors`,
// `health/visits` stored under its patient, a mixin, a ui-view, a command and a binding, and a second
// module (`billing`) for overlays. `health/visits` is HAND-WRITTEN text with comments, a flow
// mapping and a decorated enum, because "every system verb on a commented descriptor preserves
// every comment" is only provable on a file a person wrote. Invented names only — this engine is
// published.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, writeCollection, writeModule, compileQuietly, dt, git, readFile, WS_MODULE } from '../helpers/ws.js';
import { load, dump, commentCount } from '../../src/yaml.js';

const MOD = `modules/${WS_MODULE}`;
const VISITS_FILE = `${MOD}/collections/health/visits.collection.yaml`;
const PATIENTS_FILE = `${MOD}/collections/health/patients.collection.yaml`;
const VIEW_FILE = `${MOD}/ui-views/today.ui-view.yaml`;
const HOP_VIEW_FILE = `${MOD}/ui-views/by-patient.ui-view.yaml`;
const BINDING_FILE = `${MOD}/command-bindings/bill--health-visits.command-binding.yaml`;

const VISITS = [
	'# A visit is the EVENT; a patient is the person. Stored inside its patient\'s folder so a browse of',
	'# the patient folder shows the whole chart.',
	'name: health/visits',
	"record_title: '{{ reason }} · {{ date }}'",
	'description: One consultation between a patient and a doctor.',
	'use_when: a consultation happened or is booked',
	'storage:',
	'  under:',
	'    parent: patient',
	'    subfolder: visits',
	'ids:',
	'  # patient AND doctor, so two patients seeing one doctor on one day do not collide',
	"  from: '{{ date | date }}--{{ patient | basename }}--{{ doctor | basename }}'",
	'mixins: [clinic-provenance]',
	'fields:',
	'  reason:',
	'    type: string',
	'    required: true',
	'  patient:',
	'    type: health/patients',
	'    required: true',
	'  doctor:',
	'    type: health/doctors',
	'    required: true',
	'  date: { type: date, required: true }',
	'  kind:',
	'    type: string',
	'    default: follow-up',
	'    # the map order is the band order on the board',
	'    enum:',
	'      intake:',
	'        label: Intake',
	'        color: charts.blue',
	'      follow-up:',
	'        label: Follow-up',
	'  status:',
	'    type: string',
	'    default: booked',
	'    enum: [booked, seen, cancelled]',
	'    # `seen` is the only state a prescription may hang off',
	'    description: Where the visit stands.',
	'  duration_min:',
	'    type: integer',
	'    minimum: 5',
	'  fee:',
	'    type: number',
	'    display:',
	'      unit: currency',
	'      unit_field: currency',
	'  currency:',
	'    type: string',
	'    default: ILS',
	'  consultation_notes:',
	'    type: markdown',
	'    body: true',
	'constraints:',
	'  # each `if` names `required`, so a record lacking the field is not caught vacuously',
	'  - if:',
	'      required: [status]',
	'      properties:',
	'        status:',
	'          const: seen',
	'    then:',
	'      required: [duration_min]',
	'display:',
	'  nav:',
	'    icon: pulse',
	'  list:',
	'    columns: [reason, patient, date, status]',
	'    sort: -date',
	'  record:',
	"    subtitle: '{{ patient }} · {{ kind }}'",
	'    badge: status',
	'    color_by: kind',
	'  form:',
	'    sections:',
	'      - title: Visit',
	'        fields: [reason, patient, doctor, date, kind, status]',
	'',
].join('\n');

const PATIENTS = {
	description: 'A person under this clinic\'s care.',
	use_when: 'a person is named in a visit',
	storage: { shape: 'folder', entry: 'patient.md' },
	ids: { from: '{{ name | slug }}' },
	fields: {
		name: { type: 'string', required: true },
		visits: { type: 'health/visits', many: true, mirror_of: 'patient', description: 'Every visit. Set `patient` on the visit.' },
		notes: { type: 'markdown', body: true },
	},
};
const DOCTORS = {
	description: 'A doctor.',
	use_when: 'a doctor is named',
	ids: { from: '{{ name | slug }}' },
	fields: { name: { type: 'string', required: true }, notes: { type: 'markdown', body: true } },
};
const MIXIN = {
	name: 'clinic-provenance',
	description: 'Who made the record, and how much to trust it.',
	use_when: 'every clinic collection an agent may write',
	fields: { author: { type: 'string' }, confidence: { type: 'string', default: 'normal', enum: ['low', 'normal', 'high'] } },
};

/** The clinic, compiled and committed, with one doctor, one patient and one seen visit. */
function clinic({ records = true } = {}) {
	const w = workspace({ namespaces: ['health'], compile: false });
	const root = w.root;
	writeCollection(root, 'health/patients', PATIENTS);
	writeCollection(root, 'health/doctors', DOCTORS);
	fs.writeFileSync(path.join(root, VISITS_FILE), VISITS);
	const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
	put(`${MOD}/mixins/clinic-provenance.mixin.yaml`, dump(MIXIN));
	put(VIEW_FILE, dump({
		name: 'today', title: 'Today', route: '/health/visits/today', scope: 'collection', collection: 'collections/health/visits',
		filter: { status: { _eq: 'seen' } },
		display: { list: { layout: 'kanban', columns: ['reason', 'status'], options: { lanes_by: 'status', card_title: '{{ reason }}' } } },
	}));
	put(HOP_VIEW_FILE, dump({
		name: 'by-patient', title: 'By patient', route: '/health/visits/by-patient', scope: 'collection', collection: 'collections/health/visits',
		filter: { patient: { name: { _eq: 'Dana Levi' } } },
	}));
	put(`${MOD}/commands/bill.command.md`, '---\nname: bill\ndescription: Bill a visit that has been seen.\n---\nBill it.\n');
	put(BINDING_FILE, dump({
		command: 'commands/bill', collection: 'collections/health/visits', scope: 'record',
		available_when: { status: { _eq: 'seen' } }, done_when: { status: { _in: ['cancelled'] } },
	}));
	writeModule(root, 'billing', { description: 'Claims against a visit.', dependencies: [WS_MODULE] });
	git(root, ['add', '--', 'modules', 'package.json']);
	git(root, ['commit', '-qm', 'fixture: clinic']);
	compileQuietly(w.ws);
	const run = (...a) => dt(root, ...a);
	if (records) {
		ok(run('add', 'health/doctors', '--name', 'Dr Cohen'));
		ok(run('add', 'health/patients', '--name', 'Dana Levi'));
		ok(run('add', 'health/visit', 'Checkup', '--patient', 'health/patients/dana-levi', '--doctor', 'health/doctors/dr-cohen', '--date', '2026-03-04', '--status', 'seen', '--duration_min', '20'));
		ok(run('commit'));
	}
	return { ...w, dt: run, text: (rel) => readFile(root, rel), doc: (rel) => load(readFile(root, rel)), head: () => git(root, ['rev-parse', 'HEAD']) };
}

const VISIT_RECORD = 'data/health/patients/dana-levi/visits/2026-03-04--dana-levi--dr-cohen.visit.md';

function ok(res) {
	assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
	return res;
}
function refused(res, re) {
	assert.notEqual(res.code, 0, `expected a refusal:\n${res.stdout}`);
	if (re) assert.match(res.stdout + res.stderr, re);
	return res;
}
/** The lines of `a` that `b` does not have. */
const lost = (a, b) => { const s = new Set(b.split('\n')); return a.split('\n').filter((l) => !s.has(l)); };
const gained = (a, b) => lost(b, a);
const commits = (w, since) => Number(git(w.root, ['rev-list', '--count', `${since}..HEAD`]));
/** `dt check` reports no violation in a RECORD — the data the verb rewrote is valid. */
function recordsValid(w) {
	const res = w.dt('check');
	assert.doesNotMatch(res.stdout + res.stderr, /✖ data\//, res.stdout + res.stderr);
}

describe('add-field writes a v2 field', () => {
	test('it lands before the body field, and the diff is exactly the new field', () => {
		const w = clinic({ records: false });
		ok(w.dt('add-field', 'health/visits', '--name', 'room', '--type', 'string', '--required'));
		const after = w.text(VISITS_FILE);
		// the strongest form of "only the mutation": the whole file, character for character
		assert.equal(after, VISITS.replace('  consultation_notes:', '  room:\n    type: string\n    required: true\n  consultation_notes:'));
		const keys = Object.keys(load(after).fields);
		assert.equal(keys.indexOf('room'), keys.indexOf('consultation_notes') - 1);
	});

	test('each flag writes its v2 key, in canonical order', () => {
		const w = clinic({ records: false });
		ok(w.dt('add-field', 'health/visits', '--name', 'channel', '--enum', 'phone,walk-in', '--default-value', 'phone', '--description', 'How it was booked.'));
		ok(w.dt('add-field', 'health/visits', '--name', 'tags', '--type', 'string', '--many'));
		ok(w.dt('add-field', 'health/visits', '--name', 'referrer', '--type', 'health/doctors', '--on-delete', 'set-null'));
		ok(w.dt('add-field', 'health/visits', '--name', 'claim_no', '--type', 'string', '--unique', '--sensitive'));
		ok(w.dt('add-field', 'health/visits', '--name', 'seen_at', '--type', 'datetime'));
		const f = w.doc(VISITS_FILE).fields;
		assert.deepEqual(f.channel, { type: 'string', default: 'phone', enum: ['phone', 'walk-in'], description: 'How it was booked.' });
		assert.deepEqual(Object.keys(f.channel), ['type', 'default', 'enum', 'description']);
		assert.deepEqual(f.tags, { type: 'string', many: true });
		assert.deepEqual(f.referrer, { type: 'health/doctors', on_delete: 'set-null' });
		assert.deepEqual(f.claim_no, { type: 'string', unique: true, sensitive: true });
		assert.deepEqual(f.seen_at, { type: 'datetime' });
		assert.doesNotMatch(w.text(VISITS_FILE), /x-|schema:/);
	});

	test('a union of collections, and `reference`', () => {
		const w = clinic({ records: false });
		ok(w.dt('add-field', 'health/visits', '--name', 'about', '--type', 'health/patients,health/doctors'));
		ok(w.dt('add-field', 'health/visits', '--name', 'evidence', '--type', 'reference', '--many'));
		const f = w.doc(VISITS_FILE).fields;
		assert.deepEqual(f.about.type, ['health/patients', 'health/doctors']);
		assert.deepEqual(f.evidence, { type: 'reference', many: true });
	});

	test('--mirror-of writes mirror_of, the type naming the target, and the far side decides the cardinality', () => {
		const w = clinic();
		ok(w.dt('add-field', 'health/doctors', '--name', 'visits', '--type', 'health/visits', '--mirror-of', 'doctor'));
		const f = load(readFile(w.root, `${MOD}/collections/health/doctors.collection.yaml`)).fields;
		assert.deepEqual(f.visits, { type: 'health/visits', many: true, mirror_of: 'doctor' });
		// the mirror is maintained by the next write of the owning side
		ok(w.dt('add', 'health/visit', 'Follow up', '--patient', 'health/patients/dana-levi', '--doctor', 'health/doctors/dr-cohen', '--date', '2026-03-11'));
		const doc = JSON.parse(ok(w.dt('get', 'health/doctors/dr-cohen', '--json')).stdout);
		assert.ok(doc.visits.includes('health/visits/2026-03-11--dana-levi--dr-cohen'), JSON.stringify(doc));
	});

	test('--mirror-of without a collection --type, or naming a field the target lacks, is refused naming the fix', () => {
		const w = clinic({ records: false });
		refused(w.dt('add-field', 'health/doctors', '--name', 'visits', '--mirror-of', 'doctor'), /--mirror-of doctor needs --type <collection>/);
		refused(w.dt('add-field', 'health/doctors', '--name', 'visits', '--type', 'health/visits', '--mirror-of', 'nurse'), /health\/visits has no field "nurse"/);
	});

	test('the v1 spellings are simply unknown: no type `enum` or `tags`, no --options, no --inverse', () => {
		const w = clinic({ records: false });
		refused(w.dt('add-field', 'health/visits', '--name', 'x', '--type', 'enum'), /unknown type "enum" — one of string markdown/);
		refused(w.dt('add-field', 'health/visits', '--name', 'x', '--type', 'tags'), /unknown type "tags"/);
		refused(w.dt('add-field', 'health/visits', '--name', 'x', '--options', 'a,b'), /unknown flag "--options"/);
		refused(w.dt('add-field', 'health/visits', '--name', 'x', '--type', 'health/doctors', '--inverse'), /unknown flag "--inverse"/);
		assert.equal(w.text(VISITS_FILE), VISITS);
	});

	test('a flag held to its type: --body is markdown, --enum is a string, --on-delete is a reference', () => {
		const w = clinic({ records: false });
		refused(w.dt('add-field', 'health/doctors', '--name', 'bio', '--type', 'string', '--body'), /--body marks the field a record's prose lands in, so it is --type markdown/);
		refused(w.dt('add-field', 'health/visits', '--name', 'n', '--type', 'integer', '--enum', '1,2'), /--enum belongs to --type string/);
		refused(w.dt('add-field', 'health/visits', '--name', 'n', '--on-delete', 'restrict'), /--on-delete belongs to a reference/);
		assert.equal(w.text(VISITS_FILE), VISITS);
	});

	test('an injected field, an existing field and a mixin field are refused by name', () => {
		const w = clinic({ records: false });
		refused(w.dt('add-field', 'health/visits', '--name', 'created', '--type', 'datetime'), /"created" is injected by the engine/);
		refused(w.dt('add-field', 'health/visits', '--name', 'reason', '--type', 'string'), /field "reason" already exists on health\/visits/);
		refused(w.dt('add-field', 'health/visits', '--name', 'author', '--type', 'string'), /already exists on health\/visits \(from mixin "clinic-provenance"\)/);
	});

	test('--module on a collection another module owns writes a v2 OVERLAY there', () => {
		const w = clinic({ records: false });
		ok(w.dt('add-field', 'health/visits', '--name', 'claim_ref', '--type', 'string', '--module', 'billing'));
		const overlay = load(readFile(w.root, 'modules/billing/collections/health/visits.collection.yaml'));
		assert.deepEqual(overlay, { name: 'health/visits', overlay: true, fields: { claim_ref: { type: 'string' } } });
		assert.equal(w.text(VISITS_FILE), VISITS, 'the base is untouched');
		const compiled = load(readFile(w.root, '.dreamteamer/collections/health/visits.collection.yaml'));
		assert.deepEqual(compiled.compiled.overlaid_by, ['billing']);
		assert.ok(compiled.compiled.fields.claim_ref);
	});

	test('a failed gate leaves the source byte-identical', () => {
		const w = clinic({ records: false });
		// a mirror of a non-reference field passes the flag checks and is refused by the gate compile
		refused(w.dt('add-field', 'health/doctors', '--name', 'dates', '--type', 'health/visits', '--mirror-of', 'date'));
		assert.equal(readFile(w.root, `${MOD}/collections/health/doctors.collection.yaml`), dump({ name: 'health/doctors', ...DOCTORS }));
	});
});

describe('set-field changes only what a flag names', () => {
	test('--description alone keeps the type, the decorated enum and the default, and moves nothing', () => {
		const w = clinic({ records: false });
		ok(w.dt('set-field', 'health/visits', '--name', 'kind', '--description', 'What sort of visit.'));
		const after = w.text(VISITS_FILE);
		assert.deepEqual(lost(VISITS, after), []);
		assert.deepEqual(gained(VISITS, after), ['    description: What sort of visit.']);
		assert.deepEqual(w.doc(VISITS_FILE).fields.kind.enum, { intake: { label: 'Intake', color: 'charts.blue' }, 'follow-up': { label: 'Follow-up' } });
	});

	test('a new key goes in at its canonical place and the field keeps its position', () => {
		const w = clinic({ records: false });
		ok(w.dt('set-field', 'health/visits', '--name', 'status', '--required'));
		const f = w.doc(VISITS_FILE).fields;
		assert.deepEqual(Object.keys(f.status), ['type', 'required', 'default', 'enum', 'description']);
		assert.deepEqual(Object.keys(f), Object.keys(load(VISITS).fields), 'set-field never reorders');
		assert.match(w.text(VISITS_FILE), /# `seen` is the only state a prescription may hang off/);
	});

	test('the empty value clears a key, and false clears a switch', () => {
		const w = clinic({ records: false });
		ok(w.dt('set-field', 'health/visits', '--name', 'currency', '--default-value='));
		ok(w.dt('set-field', 'health/visits', '--name', 'reason', '--required', 'false'));
		const f = w.doc(VISITS_FILE).fields;
		assert.deepEqual(f.currency, { type: 'string' });
		assert.deepEqual(f.reason, { type: 'string' });
	});

	test('--enum on a decorated enum keeps each surviving value\'s decoration', () => {
		const w = clinic({ records: false });
		ok(w.dt('set-field', 'health/visits', '--name', 'kind', '--enum', 'intake,follow-up,urgent'));
		assert.deepEqual(w.doc(VISITS_FILE).fields.kind.enum, { intake: { label: 'Intake', color: 'charts.blue' }, 'follow-up': { label: 'Follow-up' }, urgent: {} });
	});

	test('asking for what is already there says so and commits nothing', () => {
		const w = clinic({ records: false });
		const before = w.head();
		const res = ok(w.dt('set-field', 'health/visits', '--name', 'reason', '--required'));
		assert.match(res.stdout, /already exactly that, nothing to do/);
		assert.equal(w.head(), before);
	});

	test('a mixin field, an injected field and an absent field are refused by name', () => {
		const w = clinic({ records: false });
		refused(w.dt('set-field', 'health/visits', '--name', 'author', '--description', 'x'), /comes from mixin "clinic-provenance" \(.*clinic-provenance\.mixin\.yaml\)/);
		refused(w.dt('set-field', 'health/visits', '--name', 'last_modified', '--description', 'x'), /injected by the engine/);
		refused(w.dt('set-field', 'health/visits', '--name', 'nope', '--description', 'x'), /no field "nope" on health\/visits/);
	});

	test('a field an overlay added is edited in the overlay', () => {
		const w = clinic({ records: false });
		ok(w.dt('add-field', 'health/visits', '--name', 'claim_ref', '--type', 'string', '--module', 'billing'));
		ok(w.dt('set-field', 'health/visits', '--name', 'claim_ref', '--description', 'The insurer claim number.'));
		assert.equal(load(readFile(w.root, 'modules/billing/collections/health/visits.collection.yaml')).fields.claim_ref.description, 'The insurer claim number.');
		assert.equal(w.text(VISITS_FILE), VISITS);
	});
});

describe('rm-field', () => {
	test('prunes the field\'s own columns, sort, badge and sections, and clears its values', () => {
		const w = clinic();
		ok(w.dt('set-field', 'health/visits', '--name', 'status', '--default-value='));
		// the constraint, the view and the binding name `status`; take them out of the way first so this
		// test is about the prune — the refusal has its own test below
		const doc = w.doc(VISITS_FILE);
		delete doc.constraints;
		fs.writeFileSync(path.join(w.root, VISITS_FILE), dump(doc));
		fs.rmSync(path.join(w.root, VIEW_FILE));
		fs.rmSync(path.join(w.root, BINDING_FILE));
		compileQuietly(w.ws);
		git(w.root, ['add', '-A', '--', 'modules']);
		git(w.root, ['commit', '-qm', 'fixture: unconstrained']);
		const res = ok(w.dt('rm-field', 'health/visits', '--name', 'status'));
		assert.match(res.stdout, /cleared its values from 1 health\/visits record/);
		const after = w.doc(VISITS_FILE);
		assert.equal(after.fields.status, undefined);
		assert.deepEqual(after.display.list.columns, ['reason', 'patient', 'date']);
		assert.equal(after.display.record.badge, undefined);
		assert.deepEqual(after.display.form.sections[0].fields, ['reason', 'patient', 'doctor', 'date', 'kind']);
		assert.doesNotMatch(readFile(w.root, VISIT_RECORD), /^status:/m);
		recordsValid(w);
	});

	test('a position elsewhere still naming it is refused, listing each one, and nothing changes', () => {
		const w = clinic();
		const before = w.head();
		const res = refused(w.dt('rm-field', 'health/visits', '--name', 'status'), /cannot rewrite \d+ positions/);
		const out = res.stdout + res.stderr;
		assert.match(out, /visits\.collection\.yaml {2}constraints\[0\]\.if\.properties\.status/);
		assert.match(out, /today\.ui-view\.yaml {2}filter\.status/);
		assert.match(out, /bill--health-visits\.command-binding\.yaml {2}available_when\.status/);
		assert.equal(w.text(VISITS_FILE), VISITS);
		assert.equal(w.head(), before);
	});

	test('the dry run lists what it would prune and what it refuses on', () => {
		const w = clinic();
		const res = ok(w.dt('rm-field', 'health/visits', '--name', 'status', '--dry-run'));
		assert.match(res.stdout, /records 1 · refs 0 · descriptors 1 · values cleared 1/);
		assert.match(res.stdout, /visits\.collection\.yaml {2}display\.list\.columns/);
		assert.match(res.stdout, /✖ .*today\.ui-view\.yaml {2}filter\.status/);
		assert.equal(w.text(VISITS_FILE), VISITS);
	});

	test('add-field then rm-field is byte-identical on a commented source', () => {
		const w = clinic({ records: false });
		ok(w.dt('add-field', 'health/visits', '--name', 'room', '--type', 'string'));
		ok(w.dt('rm-field', 'health/visits', '--name', 'room'));
		assert.equal(w.text(VISITS_FILE), VISITS);
	});

	test('removing an overlay\'s last field removes the overlay', () => {
		const w = clinic({ records: false });
		ok(w.dt('add-field', 'health/visits', '--name', 'claim_ref', '--type', 'string', '--module', 'billing'));
		ok(w.dt('rm-field', 'health/visits', '--name', 'claim_ref'));
		assert.equal(fs.existsSync(path.join(w.root, 'modules/billing/collections/health/visits.collection.yaml')), false);
	});
});

describe('collections: add scaffolds v2, set writes v2 keys', () => {
	test('add collections --mixins --id-from', () => {
		const w = clinic({ records: false });
		ok(w.dt('add', 'collections', '--name', 'health/notes', '--mixins', 'clinic-provenance', '--id-from', '{{ created | date }}--{{ author | slug }}', '--description', 'A clinical note.'));
		const doc = load(readFile(w.root, `${MOD}/collections/health/notes.collection.yaml`));
		assert.deepEqual(doc, { name: 'health/notes', description: 'A clinical note.', mixins: ['clinic-provenance'], ids: { from: '{{ created | date }}--{{ author | slug }}' }, fields: {} });
		const compiled = load(readFile(w.root, '.dreamteamer/collections/health/notes.collection.yaml'));
		assert.ok(compiled.compiled.fields.author, 'the mixin\'s fields are live');
	});

	test('without a mixin it gets the one field its records are named by, and nothing compile would default', () => {
		const w = clinic({ records: false });
		const res = ok(w.dt('add', 'collections', '--name', 'health/rooms'));
		assert.match(res.stdout, /suffix: room — override with --suffix/);
		const doc = load(readFile(w.root, `${MOD}/collections/health/rooms.collection.yaml`));
		assert.deepEqual(doc, { name: 'health/rooms', fields: { name: { type: 'string', required: true } } });
		ok(w.dt('add', 'health/rooms', '--name', 'Room 4'));
	});

	test('--template and --id-shape are unknown flags', () => {
		const w = clinic({ records: false });
		refused(w.dt('add', 'collections', '--name', 'gadgets', '--template', 'docs'), /unknown flag "--template"/);
		refused(w.dt('add', 'collections', '--name', 'gadgets', '--id-shape', 'slug'), /unknown flag "--id-shape"/);
	});

	test('set collections writes record_title and display keys, and an empty value prunes', () => {
		const w = clinic({ records: false });
		ok(w.dt('set', 'collections/health/doctors', "record_title={{ name }}", 'display.nav.icon=person', 'display.nav.order=30', 'display.nav.section=care', 'display.list.columns=name'));
		const doc = load(readFile(w.root, `${MOD}/collections/health/doctors.collection.yaml`));
		assert.equal(doc.record_title, '{{ name }}');
		assert.deepEqual(doc.display, { nav: { icon: 'person', order: 30, section: 'care' }, list: { columns: ['name'] } });
		ok(w.dt('set', 'collections/health/doctors', 'display.list.columns='));
		assert.deepEqual(load(readFile(w.root, `${MOD}/collections/health/doctors.collection.yaml`)).display, { nav: { icon: 'person', order: 30, section: 'care' } });
		refused(w.dt('set', 'collections/health/doctors', 'display.list.columns=nope'), /health\/doctors has no field nope/);
		refused(w.dt('set', 'collections/health/doctors', 'icon=x'), /"icon" is not a settable key of a collection/);
	});

	test('move collections --after writes display.nav.order', () => {
		const w = clinic({ records: false });
		ok(w.dt('set', 'collections/health/doctors', 'display.nav.order=10'));
		ok(w.dt('set', 'collections/health/patients', 'display.nav.order=20'));
		ok(w.dt('move', 'collections/health/visits', '--after', 'health/doctors'));
		assert.equal(w.doc(VISITS_FILE).display.nav.order, 15);
		assert.match(w.text(VISITS_FILE), /^# A visit is the EVENT/m);
	});
});

describe('rename-field reaches every rule-6 position, in one commit', () => {
	test('a field named by the descriptor, a template, a constraint, a view, a binding and the records', () => {
		const w = clinic();
		const before = w.head();
		const res = ok(w.dt('rename-field', 'health/visits', '--name', 'status', '--to', 'state'));
		assert.equal(commits(w, before), 1, 'ONE commit');
		const doc = w.doc(VISITS_FILE);
		assert.deepEqual(Object.keys(doc.fields), ['reason', 'patient', 'doctor', 'date', 'kind', 'state', 'duration_min', 'fee', 'currency', 'consultation_notes']);
		assert.deepEqual(doc.display.list.columns, ['reason', 'patient', 'date', 'state']);
		assert.equal(doc.display.record.badge, 'state');
		assert.deepEqual(doc.display.form.sections[0].fields, ['reason', 'patient', 'doctor', 'date', 'kind', 'state']);
		assert.deepEqual(doc.constraints[0].if, { required: ['state'], properties: { state: { const: 'seen' } } });
		const view = load(readFile(w.root, VIEW_FILE));
		assert.deepEqual(view.filter, { state: { _eq: 'seen' } });
		assert.deepEqual(view.display.list.columns, ['reason', 'state']);
		assert.equal(view.display.list.options.lanes_by, 'state');
		const binding = load(readFile(w.root, BINDING_FILE));
		assert.deepEqual(binding.available_when, { state: { _eq: 'seen' } });
		assert.deepEqual(binding.done_when, { state: { _in: ['cancelled'] } });
		assert.match(readFile(w.root, VISIT_RECORD), /^state: seen$/m);
		const changed = git(w.root, ['show', '--name-only', '--format=', 'HEAD']).split('\n');
		for (const f of [VISITS_FILE, VIEW_FILE, BINDING_FILE, VISIT_RECORD]) assert.ok(changed.includes(f), `${f} in the commit`);
		assert.match(res.stdout, /visits\.collection\.yaml {2}display\.record\.badge/);
		// every comment survives, and only the lines naming the field changed
		assert.equal(commentCount(w.text(VISITS_FILE)), commentCount(VISITS));
		assert.deepEqual(gained(VISITS, w.text(VISITS_FILE)).sort(), [
			'    badge: state', '    columns: [reason, patient, date, state]', '        fields: [reason, patient, doctor, date, kind, state]',
			'        state:', '      required: [state]', '  state:',
		].sort());
		recordsValid(w);
	});

	test('storage.under.parent, ids.from, record_title, subtitle and the far side\'s mirror_of', () => {
		const w = clinic();
		ok(w.dt('rename-field', 'health/visits', '--name', 'patient', '--to', 'subject'));
		const doc = w.doc(VISITS_FILE);
		assert.equal(doc.storage.under.parent, 'subject');
		assert.equal(doc.ids.from, '{{ date | date }}--{{ subject | basename }}--{{ doctor | basename }}');
		assert.equal(doc.display.record.subtitle, '{{ subject }} · {{ kind }}');
		assert.equal(w.doc(PATIENTS_FILE).fields.visits.mirror_of, 'subject');
		assert.match(readFile(w.root, VISIT_RECORD), /^subject: health\/patients\/dana-levi$/m);
		recordsValid(w);
	});

	test('a one-hop filter through a reference names a field of the target collection', () => {
		const w = clinic();
		ok(w.dt('rename-field', 'health/patients', '--name', 'name', '--to', 'full_name'));
		assert.deepEqual(load(readFile(w.root, HOP_VIEW_FILE)).filter, { patient: { full_name: { _eq: 'Dana Levi' } } });
		assert.equal(w.doc(PATIENTS_FILE).ids.from, '{{ full_name | slug }}');
	});

	test('a display option and a unit_field name are rewritten too', () => {
		const w = clinic();
		ok(w.dt('rename-field', 'health/visits', '--name', 'currency', '--to', 'currency_code'));
		assert.equal(w.doc(VISITS_FILE).fields.fee.display.unit_field, 'currency_code');
		ok(w.dt('rename-field', 'health/visits', '--name', 'reason', '--to', 'complaint'));
		const view = load(readFile(w.root, VIEW_FILE));
		assert.equal(view.display.list.options.card_title, '{{ complaint }}');
		assert.equal(w.doc(VISITS_FILE).record_title, '{{ complaint }} · {{ date }}');
	});

	test('--dry-run names each position and writes nothing', () => {
		const w = clinic();
		const before = w.head();
		const res = ok(w.dt('rename-field', 'health/visits', '--name', 'status', '--to', 'state', '--dry-run'));
		for (const p of ['fields.status', 'display.list.columns', 'display.record.badge', 'display.form.sections[0]', 'constraints[0].if.properties.status', 'constraints[0].if.required']) {
			assert.match(res.stdout, new RegExp(`visits\\.collection\\.yaml {2}${p.replace(/[.[\]]/g, '\\$&')}`), p);
		}
		assert.match(res.stdout, /today\.ui-view\.yaml {2}filter\.status/);
		assert.match(res.stdout, /bill--health-visits\.command-binding\.yaml {2}done_when\.status/);
		assert.match(res.stdout, /records 1 ·/);
		assert.equal(w.text(VISITS_FILE), VISITS);
		assert.equal(w.head(), before);
	});

	test('a position it cannot rewrite is refused by name: a mixin every collection listing it shares', () => {
		const w = clinic();
		const before = w.head();
		refused(w.dt('rename-field', 'health/visits', '--name', 'confidence', '--to', 'trust'), /clinic-provenance\.mixin\.yaml {2}fields\.confidence — mixin "clinic-provenance" is shared/);
		assert.equal(w.head(), before);
	});

	test('the body field keeps its prose, and a same-named field on another collection is left alone', () => {
		const w = clinic();
		ok(w.dt('set', 'health/doctors/dr-cohen', 'notes=Cardiology, Tuesdays.'));
		ok(w.dt('rename-field', 'health/doctors', '--name', 'notes', '--to', 'bio'));
		assert.equal(load(readFile(w.root, `${MOD}/collections/health/doctors.collection.yaml`)).fields.bio.body, true);
		assert.ok(w.doc(PATIENTS_FILE).fields.notes, 'patients.notes is another collection\'s field');
		assert.equal(JSON.parse(ok(w.dt('get', 'health/doctors/dr-cohen', '--json')).stdout).bio.trim(), 'Cardiology, Tuesdays.');
	});

	test('a mirror field is renamed in its own records, and an overlay naming the field is rewritten too', () => {
		const w = clinic();
		ok(w.dt('add-field', 'health/visits', '--name', 'claim_ref', '--type', 'string', '--module', 'billing'));
		const overlayFile = 'modules/billing/collections/health/visits.collection.yaml';
		const overlay = load(readFile(w.root, overlayFile));
		overlay.display = { list: { columns: ['claim_ref', 'status'] } };
		fs.writeFileSync(path.join(w.root, overlayFile), dump(overlay));
		compileQuietly(w.ws);
		git(w.root, ['add', '--', overlayFile]);
		git(w.root, ['commit', '-qm', 'fixture: overlay display']);
		ok(w.dt('rename-field', 'health/visits', '--name', 'status', '--to', 'state'));
		assert.deepEqual(load(readFile(w.root, overlayFile)).display.list.columns, ['claim_ref', 'state']);
		ok(w.dt('rename-field', 'health/patients', '--name', 'visits', '--to', 'appointments'));
		const patient = JSON.parse(ok(w.dt('get', 'health/patients/dana-levi', '--json')).stdout);
		assert.deepEqual(patient.appointments, ['health/visits/2026-03-04--dana-levi--dr-cohen']);
		assert.equal(patient.visits, undefined);
		recordsValid(w);
	});

	test('the new name is refused when it is taken or injected', () => {
		const w = clinic({ records: false });
		refused(w.dt('rename-field', 'health/visits', '--name', 'status', '--to', 'kind'), /already has a field "kind"/);
		refused(w.dt('rename-field', 'health/visits', '--name', 'status', '--to', 'created'), /already has a field "created"/);
	});
});

describe('rename-value', () => {
	test('the enum, the default, a constraint, a view filter, a binding and the records, in one commit', () => {
		const w = clinic();
		const before = w.head();
		ok(w.dt('rename-value', 'health/visits', 'status', 'seen', 'completed'));
		assert.equal(commits(w, before), 1, 'ONE commit');
		const doc = w.doc(VISITS_FILE);
		assert.deepEqual(doc.fields.status.enum, ['booked', 'completed', 'cancelled']);
		assert.deepEqual(doc.constraints[0].if.properties.status, { const: 'completed' });
		assert.deepEqual(load(readFile(w.root, VIEW_FILE)).filter, { status: { _eq: 'completed' } });
		assert.deepEqual(load(readFile(w.root, BINDING_FILE)).available_when, { status: { _eq: 'completed' } });
		assert.match(readFile(w.root, VISIT_RECORD), /^status: completed$/m);
		assert.equal(commentCount(w.text(VISITS_FILE)), commentCount(VISITS));
		recordsValid(w);
	});

	test('a default, and a decorated enum key that keeps its decoration', () => {
		const w = clinic();
		ok(w.dt('rename-value', 'health/visits', 'status', 'booked', 'scheduled'));
		assert.equal(w.doc(VISITS_FILE).fields.status.default, 'scheduled');
		ok(w.dt('rename-value', 'health/visits', 'kind', 'follow-up', 'review'));
		const kind = w.doc(VISITS_FILE).fields.kind;
		assert.deepEqual(kind.enum, { intake: { label: 'Intake', color: 'charts.blue' }, review: { label: 'Follow-up' } });
		assert.equal(kind.default, 'review');
		assert.match(readFile(w.root, VISIT_RECORD), /^kind: review$/m);
		assert.match(w.text(VISITS_FILE), /# the map order is the band order on the board/);
	});

	test('--dry-run names each position and writes nothing', () => {
		const w = clinic();
		const before = w.head();
		const res = ok(w.dt('rename-value', 'health/visits', 'status', 'seen', 'completed', '--dry-run'));
		assert.match(res.stdout, /visits\.collection\.yaml {2}fields\.status\.enum/);
		assert.match(res.stdout, /visits\.collection\.yaml {2}constraints\[0\]\.if\.properties\.status\.const/);
		assert.match(res.stdout, /today\.ui-view\.yaml {2}filter\.status\._eq/);
		assert.match(res.stdout, /bill--health-visits\.command-binding\.yaml {2}available_when\.status\._eq/);
		assert.match(res.stdout, /records 1 ·/);
		assert.equal(w.text(VISITS_FILE), VISITS);
		assert.equal(w.head(), before);
	});

	test('refused when the old value is not in the enum, the new one is, or the field has no enum', () => {
		const w = clinic({ records: false });
		refused(w.dt('rename-value', 'health/visits', 'status', 'lost', 'gone'), /"lost" is not a value of health\/visits\.status — its enum is booked, seen, cancelled/);
		refused(w.dt('rename-value', 'health/visits', 'status', 'seen', 'booked'), /"booked" is already a value/);
		refused(w.dt('rename-value', 'health/visits', 'reason', 'a', 'b'), /health\/visits\.reason has no enum/);
	});

	test('a filter selecting the old value by part of its spelling is refused by name', () => {
		const w = clinic();
		const view = load(readFile(w.root, VIEW_FILE));
		view.filter = { status: { _starts_with: 'se' } };
		fs.writeFileSync(path.join(w.root, VIEW_FILE), dump(view));
		compileQuietly(w.ws);
		git(w.root, ['add', '--', VIEW_FILE]);
		git(w.root, ['commit', '-qm', 'fixture: partial filter']);
		refused(w.dt('rename-value', 'health/visits', 'status', 'seen', 'completed'), /today\.ui-view\.yaml {2}filter\.status\._starts_with — `_starts_with: se` selects "seen"/);
		assert.equal(w.text(VISITS_FILE), VISITS);
	});
});

describe('rename collections retargets every v2 `type` naming it', () => {
	test('a reference field, the records and the files move together', () => {
		const w = clinic();
		ok(w.dt('rename', 'collections/health/doctors', 'health/physicians'));
		assert.equal(w.doc(VISITS_FILE).fields.doctor.type, 'health/physicians');
		assert.deepEqual(gained(VISITS, w.text(VISITS_FILE)), ['    type: health/physicians']);
		assert.ok(fs.existsSync(path.join(w.root, 'data/health/physicians/dr-cohen.physician.md')));
		assert.match(readFile(w.root, VISIT_RECORD), /^doctor: health\/physicians\/dr-cohen$/m);
		recordsValid(w);
	});
});

describe('every system verb on a commented descriptor preserves every comment', () => {
	const verbs = [
		['add-field', 'health/visits', '--name', 'room', '--type', 'string'],
		['set-field', 'health/visits', '--name', 'status', '--description', 'Where it stands now.'],
		['set-field', 'health/visits', '--name', 'kind', '--enum', 'intake,follow-up,urgent'],
		['rm-field', 'health/visits', '--name', 'duration_min'],
		['rename-field', 'health/visits', '--name', 'kind', '--to', 'category'],
		['rename-value', 'health/visits', 'status', 'cancelled', 'called-off'],
		['set', 'collections/health/visits', 'display.nav.order=5', 'record_title={{ reason }}'],
		['rename', 'collections/health/doctors', 'health/physicians'],
	];
	for (const argv of verbs) {
		test(argv.slice(0, 3).join(' '), () => {
			const w = clinic({ records: false });
			if (argv[0] === 'rm-field') {
				// duration_min is named by the constraint; drop that one name so the removal is legal
				fs.writeFileSync(path.join(w.root, VISITS_FILE), VISITS.replace('      required: [duration_min]', '      required: [reason]'));
				compileQuietly(w.ws);
				git(w.root, ['commit', '-qam', 'fixture']);
			}
			ok(w.dt(...argv));
			assert.equal(commentCount(readFile(w.root, VISITS_FILE)), commentCount(VISITS));
		});
	}
});
