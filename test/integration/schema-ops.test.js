// Tier 2 — the meta verbs, through the CLI, including the namespace flag.
//
// These write SOURCES behind a real compile gate, which is the property worth testing: a schema op
// that produced an uncompilable descriptor used to be discoverable only on the next command.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { workspace, simpleCollection, readFile, compileQuietly, dt as runDt } from '../helpers/ws.js';
import { load } from '../../src/yaml.js';
import { Store } from '../../src/store.js';
import { fieldDef, updateField, statedKeywords } from '../../src/schema-ops.js';

const descriptorOf = (ws, file) => load(readFile(ws.root, file));

describe('collections add', () => {
	test('creates a compilable collection in the default namespace', () => {
		const ws = workspace();
		const res = ws.dt('schema', 'add-collection', '--name', 'widgets');
		assert.equal(res.code, 0, res.stderr);

		const d = descriptorOf(ws, 'modules/default/collections/widgets.collection.yaml');
		assert.equal(d.name, 'widgets');
		assert.equal(d.storage.path, 'data/widgets');
		assert.equal(d.storage.suffix, 'widget');
		assert.equal(ws.dt('add', 'widgets', '--name', 'A').code, 0);
		assert.ok(readFile(ws.root, 'data/widgets/a.widget.md'));
	});

	test('--namespace puts it in the namespace folder with a bare suffix', () => {
		const ws = workspace({ namespaces: ['health'] });
		const res = ws.dt('schema', 'add-collection', '--namespace', 'health', '--name', 'doctors');
		assert.equal(res.code, 0, res.stderr);

		const d = descriptorOf(ws, 'modules/default/collections/health/doctors.collection.yaml');
		assert.equal(d.name, 'health/doctors');
		assert.equal(d.storage.path, 'data/health/doctors');
		// the suffix comes off the BARE name — `<id>.doctor.md`, never `<id>.health/doctor.md`
		assert.equal(d.storage.suffix, 'doctor');
	});

	test('a qualified --name is the same thing as --namespace', () => {
		const ws = workspace({ namespaces: ['health'] });
		assert.equal(ws.dt('schema', 'add-collection', '--name', 'health/doctors').code, 0);
		const d = descriptorOf(ws, 'modules/default/collections/health/doctors.collection.yaml');
		assert.equal(d.name, 'health/doctors');
		assert.equal(d.storage.path, 'data/health/doctors');
	});

	test('an undeclared namespace is refused BEFORE a file is written', () => {
		const ws = workspace();
		const res = ws.dt('schema', 'add-collection', '--name', 'health/doctors');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /"health" is not declared/);
		assert.equal(readFile(ws.root, 'modules/default/collections/health/doctors.collection.yaml'), null);
	});

	test('a duplicate name is refused', () => {
		const ws = workspace({ namespaces: ['health'] });
		assert.equal(ws.dt('schema', 'add-collection', '--name', 'health/doctors').code, 0);
		const again = ws.dt('schema', 'add-collection', '--name', 'health/doctors');
		assert.equal(again.code, 1);
		assert.match(again.stderr, /already exists/);
	});
});

describe('collections rm', () => {
	test('removes a namespaced collection', () => {
		const ws = workspace({ namespaces: ['health'] });
		ws.dt('schema', 'add-collection', '--name', 'health/doctors');
		const res = ws.dt('schema', 'rm-collection', 'health/doctors');
		assert.equal(res.code, 0, res.stderr);
		assert.equal(readFile(ws.root, 'modules/default/collections/health/doctors.collection.yaml'), null);
	});

	test('refuses while records exist, and --force overrides', () => {
		const ws = workspace({ namespaces: ['health'] });
		ws.dt('schema', 'add-collection', '--name', 'health/doctors');
		ws.dt('add', 'health/doctors', '--name', 'Dana');
		const refused = ws.dt('schema', 'rm-collection', 'health/doctors');
		assert.equal(refused.code, 1);
		assert.match(refused.stderr, /still has records/);
		assert.equal(ws.dt('schema', 'rm-collection', 'health/doctors', '--force').code, 0);
	});
});

describe('field verbs on a namespaced collection', () => {
	test('add-field, update-field and remove-field all address it by qualified name', () => {
		const ws = workspace({ namespaces: ['health'] });
		ws.dt('schema', 'add-collection', '--name', 'health/doctors');

		assert.equal(ws.dt('schema', 'add-field', 'health/doctors', '--name', 'speciality', '--type', 'string').code, 0);
		let d = descriptorOf(ws, 'modules/default/collections/health/doctors.collection.yaml');
		assert.equal(d.schema.properties.speciality.type, 'string');

		assert.equal(
			ws.dt('schema', 'update-field', 'health/doctors', '--name', 'speciality', '--type', 'enum', '--options', 'gp,ent').code,
			0,
		);
		d = descriptorOf(ws, 'modules/default/collections/health/doctors.collection.yaml');
		assert.deepEqual(d.schema.properties.speciality.enum, ['gp', 'ent']);

		assert.equal(ws.dt('schema', 'remove-field', 'health/doctors', '--name', 'speciality').code, 0);
		d = descriptorOf(ws, 'modules/default/collections/health/doctors.collection.yaml');
		assert.equal(d.schema.properties.speciality, undefined);
	});

	test('a reference field can target a namespaced collection', () => {
		const ws = workspace({ namespaces: ['health'] });
		ws.dt('schema', 'add-collection', '--name', 'health/doctors');
		ws.dt('schema', 'add-collection', '--name', 'health/visits');
		const res = ws.dt('schema', 'add-field', 'health/visits', '--name', 'doctor', '--type', 'reference', '--target', 'health/doctors');
		assert.equal(res.code, 0, res.stderr);

		ws.dt('add', 'health/doctors', '--name', 'Dana Levi');
		assert.equal(ws.dt('add', 'health/visits', '--name', 'v1', '--doctor', 'health/doctors/dana-levi').code, 0);
		assert.equal(ws.dt('check').code, 0);
	});
});

// ---- relation authoring flags ------------------------------------------------------------------
// A two-way relation is one line of YAML, and until these flags existed you had to know which line
// and which of the three source spellings to write it in. The load-bearing case is the LAST group:
// `update-field` rebuilds the prop from `fieldDef`, so an update that only touches a description
// used to silently turn a foreign key into a plain string and orphan the mirror on the other side.
describe('relation authoring flags', () => {
	function bare() {
		return workspace({ collections: {
			meetings: simpleCollection({ storage: { suffix: 'meeting' } }),
			'meeting-recordings': simpleCollection({ storage: { suffix: 'recording' } }),
		} });
	}
	const sourceOf = (ws, c) => load(readFile(ws.root, `modules/default/collections/${c}.collection.yaml`));
	const compiledOf = (ws, c) => load(readFile(ws.root, `.dreamteamer/collections/${c}.collection.yaml`));

	test('--inverse derives the default mirror name (strip singular(target)-, then singularize if unique)', () => {
		const ws = bare();
		const res = ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'meeting', '--type', 'meetings', '--inverse');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /mirror: meetings\.recordings\[\]/);
		assert.equal(compiledOf(ws, 'meetings').schema.properties.recordings.items['x-inverse-of'], 'meeting-recordings.meeting');
	});

	test('--unique makes the mirror scalar and singular', () => {
		const ws = workspace({ collections: {
			meetings: simpleCollection({ storage: { suffix: 'meeting' } }),
			'meeting-summaries': simpleCollection({ storage: { suffix: 'summary' } }),
		} });
		const res = ws.dt('schema', 'add-field', 'meeting-summaries', '--name', 'meeting', '--type', 'meetings', '--inverse', '--unique');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /mirror: meetings\.summary\b/);
		assert.equal(sourceOf(ws, 'meeting-summaries').schema.properties.meeting['x-unique'], true);
		assert.equal(compiledOf(ws, 'meetings').schema.properties.summary.type, 'string');
	});

	test('--on-delete lands on the holder', () => {
		const ws = bare();
		const res = ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'meeting', '--type', 'meetings', '--inverse', '--on-delete', 'set-null');
		assert.equal(res.code, 0, res.stderr);
		assert.equal(sourceOf(ws, 'meeting-recordings').schema.properties.meeting['x-on-delete'], 'set-null');
	});

	test('--many builds an array of references', () => {
		const ws = bare();
		const res = ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'refs', '--type', 'meetings', '--many');
		assert.equal(res.code, 0, res.stderr);
		const refs = compiledOf(ws, 'meeting-recordings').schema.properties.refs;
		assert.equal(refs.type, 'array');
		assert.equal(refs.items['x-reference'], 'meetings');
	});

	test('--many --inverse is a many-to-many: an array FK with an array mirror', () => {
		const ws = bare();
		const res = ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'meetings', '--type', 'meetings', '--many', '--inverse');
		assert.equal(res.code, 0, res.stderr);
		const fk = sourceOf(ws, 'meeting-recordings').schema.properties.meetings;
		assert.equal(fk.type, 'array');
		assert.equal(fk.items['x-inverse'], 'recordings');
		const mirror = compiledOf(ws, 'meetings').schema.properties.recordings;
		assert.equal(mirror.type, 'array');
		assert.equal(mirror.items['x-inverse-of'], 'meeting-recordings.meetings');
	});

	test('--mirror-of declares spelling B from the side being edited', () => {
		const ws = bare();
		ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'meeting', '--type', 'meetings');
		const res = ws.dt('schema', 'add-field', 'meetings', '--name', 'recordings', '--many', '--type', 'meeting-recordings', '--mirror-of', 'meeting-recordings.meeting');
		assert.equal(res.code, 0, res.stderr);
		assert.equal(compiledOf(ws, 'meetings').schema.properties.recordings.items['x-inverse-of'], 'meeting-recordings.meeting');
	});

	test('--mirror-of implies the type — the spec\'s own worked command, with nothing restated', () => {
		// It was refused: `✖ --mirror-of needs a --type <collection> reference.` — for not restating
		// what `--mirror-of recordings.meeting` had just said. And restating it was a chance to
		// disagree: compile derives the OWNER's cardinality from the authored mirror's shape.
		const ws = bare();
		ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'meeting', '--type', 'meetings');
		const res = ws.dt('schema', 'add-field', 'meetings', '--name', 'recordings', '--mirror-of', 'meeting-recordings.meeting');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		const mirror = compiledOf(ws, 'meetings').schema.properties.recordings;
		// a plain (non-unique) FK mirrors as an ARRAY of references to the owner
		assert.equal(mirror.type, 'array');
		assert.equal(mirror.items['x-reference'], 'meeting-recordings');
		assert.equal(mirror.items['x-inverse-of'], 'meeting-recordings.meeting');
		assert.equal(mirror.readOnly, true);
	});

	test('--mirror-of a UNIQUE foreign key implies a scalar, not a list', () => {
		// The cardinality is not a default, it is a derivation: a one-to-one FK can be claimed by one
		// record, so its mirror holds one reference. Getting this wrong is a compile error on the far
		// side of the write ("is an array mirror of the unique FK"), which is why the flag derives it.
		const ws = bare();
		ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'meeting', '--type', 'meetings', '--unique');
		const res = ws.dt('schema', 'add-field', 'meetings', '--name', 'recording', '--mirror-of', 'meeting-recordings.meeting');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		const mirror = compiledOf(ws, 'meetings').schema.properties.recording;
		assert.equal(mirror.type, 'string');
		assert.equal(mirror['x-inverse-of'], 'meeting-recordings.meeting');
	});

	test('a --type that contradicts --mirror-of is an error that says why', () => {
		const ws = bare();
		ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'meeting', '--type', 'meetings');
		const res = ws.dt('schema', 'add-field', 'meetings', '--name', 'recordings', '--type', 'meetings', '--mirror-of', 'meeting-recordings.meeting');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /makes this field a mirror of meeting-recordings, so --type meetings contradicts it/);

		// a --type that AGREES is fine — nothing forces the caller to drop a spelling that is right
		const ok = ws.dt('schema', 'add-field', 'meetings', '--name', 'recordings', '--type', 'meeting-recordings', '--mirror-of', 'meeting-recordings.meeting');
		assert.equal(ok.code, 0, ok.stdout + ok.stderr);
	});

	test('--mirror-of names the two halves separately when either is wrong', () => {
		const ws = bare();
		const shape = ws.dt('schema', 'add-field', 'meetings', '--name', 'x', '--mirror-of', 'meeting-recordings');
		assert.equal(shape.code, 1);
		assert.match(shape.stderr, /--mirror-of takes <collection>\.<field>/);
		const unknown = ws.dt('schema', 'add-field', 'meetings', '--name', 'y', '--mirror-of', 'nope.meeting');
		assert.equal(unknown.code, 1);
		assert.match(unknown.stderr, /there is no collection "nope"/);
	});

	test('update-field without relation flags PRESERVES the relation keywords', () => {
		const ws = bare();
		ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'meeting', '--type', 'meetings', '--inverse');
		const res = ws.dt('schema', 'update-field', 'meeting-recordings', '--name', 'meeting', '--description', 'the call this captures');
		assert.equal(res.code, 0, res.stderr);
		const meeting = sourceOf(ws, 'meeting-recordings').schema.properties.meeting;
		assert.equal(meeting['x-reference'], 'meetings');
		assert.equal(meeting['x-inverse'], 'recordings');
		assert.equal(meeting.description, 'the call this captures');
	});

	test('update-field --inverse adds a mirror to an EXISTING foreign key', () => {
		// The migration path: a plain FK written before relations existed gains its mirror without
		// restating --type. fieldDef alone cannot resolve this — the target only arrives with the
		// carry-forward — and the first cut refused it outright.
		const ws = bare();
		ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'meeting', '--type', 'meetings');
		const res = ws.dt('schema', 'update-field', 'meeting-recordings', '--name', 'meeting', '--inverse');
		assert.equal(res.code, 0, res.stderr);
		assert.equal(sourceOf(ws, 'meeting-recordings').schema.properties.meeting['x-inverse'], 'recordings');
		assert.equal(compiledOf(ws, 'meetings').schema.properties.recordings.items['x-inverse-of'], 'meeting-recordings.meeting');
	});

	test('records that already carry the key are counted, with the rebuild that repairs them', () => {
		const ws = bare();
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'meeting', '--type', 'meetings');
		ws.dt('add', 'meeting-recordings', '--name', 'Cap1', '--meeting', 'meetings/standup');
		ws.dt('add', 'meeting-recordings', '--name', 'Cap2', '--meeting', 'meetings/standup');
		const res = ws.dt('schema', 'update-field', 'meeting-recordings', '--name', 'meeting', '--inverse');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /2 meeting-recordings records carry values — run: dreamteamer relations rebuild meetings/);
		// and the hint is not decoration: check says the same thing about the same records
		assert.equal(ws.dt('check').code, 1);
		assert.equal(ws.dt('relations', 'rebuild', 'meetings').code, 0);
		assert.equal(ws.dt('check').code, 0);
	});

	test('--inverse on a field that references nothing is refused, not silently ignored', () => {
		const ws = bare();
		const res = ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'quality', '--type', 'string', '--inverse');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /--inverse needs a --type <collection> reference/);
	});

	test('update-field --inverse "" drops the mirror', () => {
		const ws = bare();
		ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'meeting', '--type', 'meetings', '--inverse');
		const res = ws.dt('schema', 'update-field', 'meeting-recordings', '--name', 'meeting', '--inverse=');
		assert.equal(res.code, 0, res.stderr);
		const meeting = sourceOf(ws, 'meeting-recordings').schema.properties.meeting;
		assert.equal(meeting['x-inverse'], undefined);
		assert.equal(meeting['x-reference'], 'meetings'); // the reference survives; only the mirror goes
		assert.equal(compiledOf(ws, 'meetings').schema.properties.recordings, undefined);
	});

	test('remove-field on a GENERATED mirror says it is generated, and names the verb that removes it', () => {
		// I5. It said the field was "inherited from the base module — the workspace descriptor
		// doesn't declare it", which is a true sentence about a different situation: the workspace
		// descriptor does not declare it because COMPILE writes it, and the reader who follows that
		// advice goes looking for a base module that has no such field either.
		const ws = bare();
		ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'meeting', '--type', 'meetings', '--inverse');
		const res = ws.dt('schema', 'remove-field', 'meetings', '--name', 'recordings');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /GENERATED from meeting-recordings\.meeting/);
		assert.match(res.stderr, /dreamteamer schema update-field meeting-recordings --name meeting --inverse=/);
		assert.doesNotMatch(res.stderr, /inherited/);
	});

	test('update-field on a NON-relation field is unchanged — no relation keywords appear', () => {
		const ws = bare();
		ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'quality', '--type', 'string', '--description', 'how clean the audio is');
		const res = ws.dt('schema', 'update-field', 'meeting-recordings', '--name', 'quality', '--type', 'enum', '--options', 'clear,noisy');
		assert.equal(res.code, 0, res.stderr);
		const quality = sourceOf(ws, 'meeting-recordings').schema.properties.quality;
		assert.deepEqual(quality.enum, ['clear', 'noisy']);
		assert.equal(quality.description, 'how clean the audio is'); // the pre-existing carry still works
		assert.deepEqual(Object.keys(quality).filter((k) => k.startsWith('x-')), []);
	});
});


// ---- one notion of "the flag was stated" -------------------------------------------------------
// `--required true` is the documented spelling for a boolean flag in this CLI, so `--unique true` is
// what a user types. When the carry map's "stated" (any value) and fieldDef's "on" (literal `true`)
// disagree, a stated-but-not-written keyword is dropped by BOTH — the flag says one thing, the
// source loses the keyword, and the command exits 0. Every spelling below destroyed a relation.
describe('a stated relation flag means the same thing everywhere', () => {
	function bare() {
		return workspace({ collections: {
			meetings: simpleCollection({ storage: { suffix: 'meeting' } }),
			'meeting-recordings': simpleCollection({ storage: { suffix: 'recording' } }),
		} });
	}
	const sourceOf = (ws, c) => load(readFile(ws.root, `modules/default/collections/${c}.collection.yaml`));
	/** a one-to-one FK: meeting-recordings.meeting → meetings.recording (scalar, unique) */
	function withUniqueFk() {
		const ws = bare();
		const add = ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'meeting', '--type', 'meetings', '--inverse', '--unique');
		assert.equal(add.code, 0, add.stderr);
		assert.equal(sourceOf(ws, 'meeting-recordings').schema.properties.meeting['x-unique'], true);
		return ws;
	}

	for (const spelling of [['--unique'], ['--unique', 'true'], ['--unique=true']]) {
		test(`update-field ${spelling.join(' ')} keeps the one-to-one`, () => {
			const ws = withUniqueFk();
			// `--description` so this is a REAL write: restating --unique on an already-unique field is
			// now correctly a no-op, and a no-op cannot show that the keyword survives the rebuild.
			const res = ws.dt('schema', 'update-field', 'meeting-recordings', '--name', 'meeting', ...spelling, '--description', 'the call');
			assert.equal(res.code, 0, res.stderr);
			const meeting = sourceOf(ws, 'meeting-recordings').schema.properties.meeting;
			assert.equal(meeting['x-unique'], true, 'x-unique must survive its own flag');
			assert.equal(meeting['x-inverse'], 'recording');
			assert.match(res.stdout, /mirror: meetings\.recording\b/); // scalar: no []
		});
	}

	test('update-field --unique false CLEARS it — a stated flag is not a carried one', () => {
		const ws = withUniqueFk();
		const res = ws.dt('schema', 'update-field', 'meeting-recordings', '--name', 'meeting', '--unique', 'false');
		assert.equal(res.code, 0, res.stderr);
		const meeting = sourceOf(ws, 'meeting-recordings').schema.properties.meeting;
		assert.equal(meeting['x-unique'], undefined);
		assert.equal(meeting['x-inverse'], 'recording'); // only the stated keyword moves
	});

	test('update-field --many true keeps the array FK an array', () => {
		const ws = bare();
		ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'meetings', '--type', 'meetings', '--many');
		// `--description` so the write is a real one: `--many true` on an already-array FK changes
		// nothing on its own, and a no-op update-field trips the write gate's empty-commit failure —
		// a pre-existing wart of every restating update, not the behaviour under test here.
		const res = ws.dt('schema', 'update-field', 'meeting-recordings', '--name', 'meetings', '--many', 'true', '--description', 'the calls this captures');
		assert.equal(res.code, 0, res.stderr);
		const fk = sourceOf(ws, 'meeting-recordings').schema.properties.meetings;
		assert.equal(fk.type, 'array', 'an array FK must not be rewritten to a scalar under records that hold lists');
		assert.equal(fk.items['x-reference'], 'meetings');
	});

	test('update-field --many false demotes it to a scalar, deliberately', () => {
		const ws = bare();
		ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'meetings', '--type', 'meetings', '--many');
		assert.equal(ws.dt('schema', 'update-field', 'meeting-recordings', '--name', 'meetings', '--many', 'false').code, 0);
		const fk = sourceOf(ws, 'meeting-recordings').schema.properties.meetings;
		assert.equal(fk.type, 'string');
		assert.equal(fk['x-reference'], 'meetings');
	});

	test('the relation flags are refused on a field that references nothing — all of them, alike', () => {
		// ⚠ `--mirror-of` is deliberately NOT in this list: it names a `<collection>.<field>` and so
		// SUPPLIES the reference rather than depending on one — see the `--mirror-of implies the type`
		// case below. Every other relation flag is meaningless without a target and refused for it.
		const ws = bare();
		for (const flag of [['--inverse'], ['--unique'], ['--on-delete', 'set-null'], ['--many']]) {
			const res = ws.dt('schema', 'add-field', 'meeting-recordings', '--name', `q${flag[0].slice(2)}`, '--type', 'string', ...flag);
			assert.equal(res.code, 1, `${flag[0]} on a non-reference should be refused, got:\n${res.stdout}`);
			assert.match(res.stderr, /needs a --type <collection> reference|needs a single-collection/);
		}
	});

	test('--on-delete only takes restrict or set-null', () => {
		const ws = bare();
		const res = ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'meeting', '--type', 'meetings', '--inverse', '--on-delete', 'cascade');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /--on-delete takes restrict or set-null/);
	});

	test('the migration hint survives the array reshape', () => {
		// updateField REASSIGNS prop when it rebuilds the scalar fieldDef produced into an array, so
		// a caller reporting off its own copy saw a stale object and printed nothing — on exactly the
		// path where the hint matters, because check fails on the very next command.
		const ws = bare();
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'meetings', '--type', 'meetings', '--many');
		ws.dt('add', 'meeting-recordings', '--name', 'Cap1', '--meetings', 'meetings/standup');
		ws.dt('add', 'meeting-recordings', '--name', 'Cap2', '--meetings', 'meetings/standup');
		const res = ws.dt('schema', 'update-field', 'meeting-recordings', '--name', 'meetings', '--inverse');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /mirror: meetings\.recordings\[\]/);
		assert.match(res.stdout, /2 meeting-recordings records carry values — run: dreamteamer relations rebuild meetings/);
		assert.equal(ws.dt('check').code, 1); // and the hint is not decoration
		assert.equal(ws.dt('relations', 'rebuild', 'meetings').code, 0);
		assert.equal(ws.dt('check').code, 0);
	});

	test('one record reads as one record', () => {
		const ws = bare();
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'meeting', '--type', 'meetings');
		ws.dt('add', 'meeting-recordings', '--name', 'Cap1', '--meeting', 'meetings/standup');
		const res = ws.dt('schema', 'update-field', 'meeting-recordings', '--name', 'meeting', '--inverse');
		assert.match(res.stdout, /1 meeting-recordings record carries values/);
	});

	test('updateField: a caller stating `type` retypes a reference field away', () => {
		// The HTTP schema endpoint calls updateField directly. It passed no flags, so `type` was never
		// "stated", x-reference was ALWAYS carried, the retype was a silent no-op — and the resulting
		// zero-byte diff failed the commit gate with "the schema change was rolled back".
		const ws = bare();
		ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'meeting', '--type', 'meetings', '--inverse');
		const store = new Store(ws.ws);
		const body = { name: 'meeting', type: 'string' };
		updateField(ws.ws, store, 'meeting-recordings', 'meeting', {
			prop: fieldDef(store, body, 'meeting-recordings'), required: undefined, flags: body, stated: statedKeywords(body),
		});
		const meeting = sourceOf(ws, 'meeting-recordings').schema.properties.meeting;
		assert.equal(meeting.type, 'string');
		assert.equal(meeting['x-reference'], undefined);
		assert.equal(meeting['x-inverse'], undefined); // the dependent keyword goes with the reference
	});

	test('updateField: a caller that supplies a whole prop and no `stated` carries nothing forward', () => {
		// server.js's `b.prop` path — the studio's field drawer sends the complete field. Omitting
		// `stated` must mean "I stated everything", never "keep whatever was there".
		const ws = bare();
		ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'meeting', '--type', 'meetings', '--inverse');
		updateField(ws.ws, new Store(ws.ws), 'meeting-recordings', 'meeting', { prop: { type: 'boolean' } });
		const meeting = sourceOf(ws, 'meeting-recordings').schema.properties.meeting;
		assert.equal(meeting.type, 'boolean');
		assert.equal(meeting['x-reference'], undefined);
	});
});


// ---- an idempotent schema command is a SUCCESS -------------------------------------------------
// A write that changes nothing produced a byte-identical source, and the write gate's `git commit`
// then failed with "the schema change was rolled back, nothing was changed" — pointing at git for a
// command that did exactly what was asked, on a workspace left correct. Ten distinct CORRECT
// spellings hit it, so an "apply my schema" script failed on every already-satisfied field, as did
// any retry after a partial failure. `rename-collection` set the precedent: say so, and exit 0.
describe('an idempotent update-field says so and exits 0', () => {
	function fk({ unique = false, many = false } = {}) {
		const ws = workspace({ collections: {
			meetings: simpleCollection({ storage: { suffix: 'meeting' } }),
			'meeting-recordings': simpleCollection({ storage: { suffix: 'recording' } }),
		} });
		const add = ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'meeting', '--type', 'meetings',
			...(many ? ['--many'] : []), '--inverse', ...(unique ? ['--unique'] : []));
		assert.equal(add.code, 0, add.stderr);
		return ws;
	}
	const sourceOf = (ws) => load(readFile(ws.root, 'modules/default/collections/meeting-recordings.collection.yaml'));

	// five of the ten spellings the matrix found, one per shape of no-op
	const cases = [
		['a plain re-run of the same update', {}, ['--inverse']],
		['--inverse= on a field that has no mirror', {}, ['--inverse=']],
		['--unique false on a non-unique FK', {}, ['--unique', 'false']],
		['--many false on a scalar FK', {}, ['--many', 'false']],
		['--type restated, unchanged', {}, ['--type', 'meetings']],
	];
	for (const [what, opts, flags] of cases) {
		test(what, () => {
			const ws = fk(opts);
			// the first --inverse= actually removes the mirror; run it twice so the SECOND is the no-op
			if (flags[0] === '--inverse=') ws.dt('schema', 'update-field', 'meeting-recordings', '--name', 'meeting', ...flags);
			const before = sourceOf(ws);
			const res = ws.dt('schema', 'update-field', 'meeting-recordings', '--name', 'meeting', ...flags);
			assert.equal(res.code, 0, res.stdout + res.stderr);
			assert.doesNotMatch(res.stdout + res.stderr, /git commit failed|rolled back/);
			assert.match(res.stdout, /meeting-recordings\.meeting — already exactly that, nothing to do/);
			assert.deepEqual(sourceOf(ws), before, 'a no-op must leave the source untouched');
			assert.equal(ws.dt('check').code, 0);
		});
	}

	// ⚠ AND IT IS STILL A GATE. Every schema op goes through `writeGated`, which compiles the WHOLE
	// workspace and hard-fails on any pre-existing error anywhere in the tree — so before the no-op
	// shortcut existed, even a command that changed nothing validated the runtime. Returning early
	// bypassed that: "already exactly that" became a success claim about a workspace nobody had
	// compiled, which is precisely what an idempotent "apply my schema" script must never get.
	test('a no-op still fails on an UNRELATED compile error, the way the gate would', () => {
		const ws = fk();
		fs.writeFileSync(`${ws.root}/modules/default/collections/broken.collection.yaml`,
			'name: broken\ndescription: A deliberately broken, unrelated collection.\nid:\n  generate: "{{ name | slug }}"\n'
			+ 'storage:\n  suffix: broken\nschema:\n  type: object\n  required: [name]\n  properties:\n'
			+ '    name: { type: string }\n    ghost: { type: string, x-reference: no-such-collection }\n');
		assert.equal(ws.dt('compile').code, 1, 'the fixture must actually be broken');

		const res = ws.dt('schema', 'update-field', 'meeting-recordings', '--name', 'meeting', '--inverse');
		assert.equal(res.code, 1, `a no-op on a broken tree must not report success:\n${res.stdout}`);
		assert.match(res.stdout + res.stderr, /compile error: collection "broken"/);
		assert.doesNotMatch(res.stdout, /already exactly that/);
		assert.doesNotMatch(res.stdout + res.stderr, /git commit failed|rolled back/);
	});

	test('a healthy no-op validates, says so, and commits nothing', () => {
		const ws = fk();
		// UNCHANGED, not empty: the fixture writes its collections after the base commit, so there is
		// already untracked noise here that has nothing to do with this command.
		const commits = ws.git(['rev-list', '--count', 'HEAD']);
		const status = ws.git(['status', '--porcelain']);
		const res = ws.dt('schema', 'update-field', 'meeting-recordings', '--name', 'meeting', '--inverse');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /already exactly that, nothing to do/);
		assert.equal(ws.git(['rev-list', '--count', 'HEAD']), commits, 'a no-op writes no commit');
		assert.equal(ws.git(['status', '--porcelain']), status, 'and stages nothing');
	});

	test('the run that DOES change something still reports the change', () => {
		const ws = fk();
		const res = ws.dt('schema', 'update-field', 'meeting-recordings', '--name', 'meeting', '--description', 'the call');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /✔ compiled — the field is updated/);
		assert.doesNotMatch(res.stdout, /nothing to do/);
	});
});

// ---- cardinality belongs to --many, never to --type --------------------------------------------
describe('restating --type keeps the cardinality', () => {
	test('an array FK holding ONE value survives --type <the same collection>', () => {
		// ⚠ the single-valued case specifically: check runs ajv with coerceTypes: 'array' and unwraps a
		// one-element list, so a collapsed array FK passed `check` clean. Two elements is caught; one
		// is not, which makes the source shape the only assertion that can see this.
		const ws = workspace({ collections: {
			meetings: simpleCollection({ storage: { suffix: 'meeting' } }),
			'meeting-recordings': simpleCollection({ storage: { suffix: 'recording' } }),
		} });
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'meetings', '--type', 'meetings', '--many', '--inverse');
		ws.dt('add', 'meeting-recordings', '--name', 'Cap1', '--meetings', 'meetings/standup');
		assert.equal(ws.dt('check').code, 0);

		const res = ws.dt('schema', 'update-field', 'meeting-recordings', '--name', 'meetings', '--type', 'meetings', '--description', 'the calls');
		assert.equal(res.code, 0, res.stderr);
		const fk = load(readFile(ws.root, 'modules/default/collections/meeting-recordings.collection.yaml')).schema.properties.meetings;
		assert.equal(fk.type, 'array', 'restating --type must not collapse an array FK to a scalar');
		assert.equal(fk.items['x-reference'], 'meetings');
		assert.equal(fk.items['x-inverse'], 'recordings', 'and the mirror stays on the items node');
		assert.equal(readFile(ws.root, 'data/meeting-recordings/cap1.recording.md').includes('- meetings/standup'), true);
		assert.equal(ws.dt('check').code, 0);
	});

	test('--many false alongside a restated --type still demotes, deliberately', () => {
		const ws = workspace({ collections: {
			meetings: simpleCollection({ storage: { suffix: 'meeting' } }),
			'meeting-recordings': simpleCollection({ storage: { suffix: 'recording' } }),
		} });
		ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'meetings', '--type', 'meetings', '--many');
		assert.equal(ws.dt('schema', 'update-field', 'meeting-recordings', '--name', 'meetings', '--type', 'meetings', '--many', 'false').code, 0);
		const fk = load(readFile(ws.root, 'modules/default/collections/meeting-recordings.collection.yaml')).schema.properties.meetings;
		assert.equal(fk.type, 'string');
		assert.equal(fk['x-reference'], 'meetings');
	});
});

// ── a descriptor is HAND-WRITTEN, and a schema op must not silently rewrite its prose ───────────
//
// PARTIAL, DELIBERATELY, AND THE BOUNDARY IS ASSERTED IN BOTH DIRECTIONS. `add-field` rewrote the
// source through `load` → mutate → `dump`, and `dump` cannot round-trip a comment — so every comment
// in the file went. Measured on a four-comment descriptor: one add-field took it to zero. The
// consequence was not cosmetic: the schema verbs were unusable on any commented descriptor, so real
// relations got authored by hand in an editor instead — the CLI losing to a text editor for a job it
// owns. `reattachComments` recovers the TOP-LEVEL blocks; the second test below pins what it still
// cannot do, so nobody reads the partial as a full fix.
describe('descriptor comments survive a schema op', () => {
	/** A commented descriptor of the shape a module actually ships: a file header, a block above a
	 *  top-level key, and one explaining a single FIELD (i.e. nested). */
	function commented() {
		const ws = workspace({ compile: false });
		fs.writeFileSync(`${ws.root}/modules/default/collections/things.collection.yaml`, [
			'# THINGS — this header is why the collection exists, which is the whole reason a module',
			'# source is hand-written rather than generated.',
			'name: things',
			'description: A thing.',
			'',
			'# the id rule is deliberate: a thing has no natural key',
			'id:',
			"  generate: '{{ name | slug }}'",
			'storage: { suffix: thing }',
			'schema:',
			'  type: object',
			'  required: [name]',
			'  properties:',
			'    name: { type: string }',
			'    # ⚠ nested: the importer reads this and nothing validates the spelling',
			'    vendor_code: { type: string }',
			'',
		].join('\n'));
		compileQuietly(ws.ws);
		return ws;
	}
	const commentsOf = (ws) => readFile(ws.root, 'modules/default/collections/things.collection.yaml')
		.split('\n').filter((l) => l.trim().startsWith('#'));

	test('a top-level comment block survives add-field AND remove-field', () => {
		const ws = commented();
		assert.equal(commentsOf(ws).length, 4);

		const add = runDt(ws.root, 'schema', 'add-field', 'things', '--name', 'colour', '--type', 'string');
		assert.equal(add.code, 0, add.stderr);
		const after = commentsOf(ws);
		assert.ok(after.some((l) => l.includes('THINGS — this header')), `the file header went:\n${after.join('\n')}`);
		assert.ok(after.some((l) => l.includes('the id rule is deliberate')), 'the block above a top-level key went');

		// …and the same on the way back out — both writers go through one `writeDescriptor`
		assert.equal(runDt(ws.root, 'schema', 'remove-field', 'things', '--name', 'colour').code, 0);
		assert.ok(commentsOf(ws).some((l) => l.includes('THINGS — this header')));
	});

	test('a NESTED comment does not survive — the limit, asserted so it cannot be mistaken for fixed', () => {
		// Re-placing a comment from inside `schema.properties` needs to know where that key ended up,
		// and a misplaced comment is worse than an absent one: it attaches an explanation to something
		// it does not explain. Fixing this needs a YAML library that keeps a document's syntax tree.
		const ws = commented();
		assert.ok(commentsOf(ws).some((l) => l.includes('nested: the importer')));
		assert.equal(runDt(ws.root, 'schema', 'add-field', 'things', '--name', 'colour', '--type', 'string').code, 0);
		assert.ok(
			!commentsOf(ws).some((l) => l.includes('nested: the importer')),
			'a nested comment surviving would be good news — and would mean this test is now the wrong shape, not that it should be deleted');
	});

	test('STYLE is still lost, and that is the other half of the same limit', () => {
		// `dump` emits its own defaults, so an inline mapping comes back as a block one. Named here
		// because it is what makes the diff of a one-field edit the whole file — the record half of the
		// same problem lives at a different call site (store.serialize) and is untouched.
		const ws = commented();
		assert.match(readFile(ws.root, 'modules/default/collections/things.collection.yaml'), /storage: \{ suffix: thing \}/);
		assert.equal(runDt(ws.root, 'schema', 'add-field', 'things', '--name', 'colour', '--type', 'string').code, 0);
		assert.match(readFile(ws.root, 'modules/default/collections/things.collection.yaml'), /storage:\n {2}suffix: thing/);
	});
});

// ── a description-only edit must not RETYPE the field ───────────────────────────────────────────
//
// The same silent-corruption class as the relation-keyword carry, and the reason that carry was not
// enough: it named five keywords, and the problem is every keyword. `fieldDef` builds a prop from the
// flags ALONE, so a call naming no `--type` came back `{type: string}` — the default of a function
// that was told nothing — and `upsertField` writes what it is handed. Measured before the fix, one
// `update-field --description "…"` each: a markdown body field, a date, an enum, an array and a
// number ALL came back a plain string, losing format, enum, items, default and the numeric bounds.
// The ones that WIDEN are invisible to `check` — a string accepts everything the number held.
describe('update-field carries every keyword no flag restated', () => {
	function shapes() {
		const ws = workspace();
		assert.equal(ws.dt('schema', 'add-collection', '--name', 'shapes').code, 0);
		const add = (...a) => assert.equal(ws.dt('schema', 'add-field', 'shapes', ...a).code, 0);
		add('--name', 'prose', '--type', 'markdown', '--body');
		add('--name', 'due', '--type', 'date');
		add('--name', 'status', '--type', 'enum', '--options', 'todo,doing,done');
		add('--name', 'labels', '--type', 'tags');
		add('--name', 'score', '--type', 'number', '--default-value', '3');
		// a hand-authored constraint, which no flag can express and nothing else would preserve
		const file = `${ws.root}/modules/default/collections/shapes.collection.yaml`;
		fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('      default: 3\n', '      default: 3\n      minimum: 0\n'));
		assert.equal(ws.dt('compile').code, 0);
		return ws;
	}
	const propOf = (ws, f) => load(readFile(ws.root, 'modules/default/collections/shapes.collection.yaml')).schema.properties[f];

	test('--description alone keeps the type, the format, the enum, the items and the constraints', () => {
		const ws = shapes();
		for (const f of ['prose', 'due', 'status', 'labels', 'score']) {
			const res = ws.dt('schema', 'update-field', 'shapes', '--name', f, '--description', 'a description');
			assert.equal(res.code, 0, res.stderr);
			assert.equal(propOf(ws, f).description, 'a description');
		}
		assert.equal(propOf(ws, 'prose').format, 'markdown');
		assert.equal(propOf(ws, 'prose')['x-body'], true);
		assert.equal(propOf(ws, 'due').format, 'date');
		assert.deepEqual(propOf(ws, 'status').enum, ['todo', 'doing', 'done']);
		assert.equal(propOf(ws, 'labels').type, 'array', 'a list must not come back a scalar');
		assert.deepEqual(propOf(ws, 'labels').items, { type: 'string' });
		assert.equal(propOf(ws, 'score').type, 'number', 'a number must not come back a string');
		assert.equal(propOf(ws, 'score').default, 3);
		assert.equal(propOf(ws, 'score').minimum, 0, 'a hand-authored constraint no flag can express');
		assert.equal(ws.dt('check').code, 0);
	});

	test('a DELIBERATE --type still retypes, and takes the old shape with it', () => {
		// `--type` owns the whole shape — "this field is a string now" cannot leave `minimum: 0`
		// behind. This is the line between the two behaviours and the reason the carry is keyed on
		// whether `--type` was passed rather than on a list of safe keywords.
		const ws = shapes();
		assert.equal(ws.dt('schema', 'update-field', 'shapes', '--name', 'score', '--type', 'string').code, 0);
		const p = propOf(ws, 'score');
		assert.equal(p.type, 'string');
		assert.equal(p.default, undefined);
		assert.equal(p.minimum, undefined);
	});

	test('a restating flag still REPLACES what it owns', () => {
		const ws = shapes();
		assert.equal(ws.dt('schema', 'update-field', 'shapes', '--name', 'status', '--options', 'open,shut').code, 0);
		assert.deepEqual(propOf(ws, 'status').enum, ['open', 'shut']);
		assert.equal(ws.dt('schema', 'update-field', 'shapes', '--name', 'score', '--default-value', '7').code, 0);
		assert.equal(propOf(ws, 'score').default, 7);
		assert.equal(propOf(ws, 'score').minimum, 0, 'and only what it owns');
		assert.equal(ws.dt('schema', 'update-field', 'shapes', '--name', 'prose', '--body', 'false').code, 0);
		assert.equal(propOf(ws, 'prose')['x-body'], undefined);
	});

	test('the carried items cannot make a mirror unclearable', () => {
		// ⚠ THE REGRESSION THIS CARRY INVITES. Carrying `items` wholesale would bring `x-inverse` with
		// it, and `--inverse=` fills only what is undefined — so the mirror could never be dropped
		// again. The carried items arrives stripped of relation keywords; the relation carry below it
		// is what puts them back, and it is the one that knows `--unique false` CLEARS.
		const ws = workspace({ collections: {
			meetings: simpleCollection({ storage: { suffix: 'meeting' } }),
			'meeting-recordings': simpleCollection({ storage: { suffix: 'recording' } }),
		} });
		const upd = (...a) => assert.equal(ws.dt('schema', 'update-field', 'meeting-recordings', '--name', 'meeting', ...a).code, 0);
		const src = () => load(readFile(ws.root, 'modules/default/collections/meeting-recordings.collection.yaml')).schema.properties.meeting;
		assert.equal(ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'meeting', '--type', 'meetings', '--many', '--inverse').code, 0);

		upd('--description', 'the calls');
		assert.equal(src().type, 'array', 'the array FK survives a description-only edit');
		assert.equal(src().items['x-inverse'], 'recordings', '…and so does its mirror');

		upd('--inverse=');
		assert.equal(src().items['x-inverse'], undefined, 'a carried items would have made this impossible');
		assert.equal(src().items['x-reference'], 'meetings', 'the reference stays; only the mirror goes');

		upd('--many', 'false');
		assert.equal(src().type, 'string');
		upd('--inverse', '--unique');
		assert.equal(src()['x-unique'], true);
		upd('--unique', 'false');
		assert.equal(src()['x-unique'], undefined);
		assert.equal(src()['x-inverse'], 'recording', 'clearing x-unique does not clear the mirror');
		assert.equal(ws.dt('check').code, 0);
	});
});

// ── a collection name outranks the type sugar ───────────────────────────────────────────────────
//
// `fieldDef`'s switch answered `tags` before it ever asked whether the workspace HAS a `tags`
// collection, so in a workspace that ships one — the ordinary case, since "tags" is a noun a vault
// keeps records of — the collection was unreferenceable. `--type tags` produced a plain array of
// strings with no `x-reference`, and every relation flag was then refused for naming no reference
// (`✖ --many needs a --type <collection> reference.`) while the collection sat in the same runtime.
// Neither half said why. Same shape for a collection called `enum`, `date` or `text`.
describe('a type that names a collection is a reference, sugar or not', () => {
	const withTags = () => workspace({ collections: {
		tags: simpleCollection({ storage: { suffix: 'tag' } }),
		articles: simpleCollection({ storage: { suffix: 'article' } }),
	} });
	const sourceOf = (ws, c) => load(readFile(ws.root, `modules/default/collections/${c}.collection.yaml`));

	test('--type tags --many references the tags COLLECTION when the workspace ships one', () => {
		const ws = withTags();
		const res = ws.dt('schema', 'add-field', 'articles', '--name', 'labels', '--type', 'tags', '--many');
		assert.equal(res.code, 0, res.stderr);
		const p = sourceOf(ws, 'articles').schema.properties.labels;
		assert.equal(p.type, 'array');
		assert.equal(p.items['x-reference'], 'tags', 'the sugar shadowed a real collection');
		assert.equal(ws.dt('check').code, 0);
	});

	test('…and the relation flags work on it, rather than being refused for naming nothing', () => {
		const ws = withTags();
		const res = ws.dt('schema', 'add-field', 'articles', '--name', 'labels', '--type', 'tags', '--many', '--inverse');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /mirror: tags\.articles\[\]/);
		assert.equal(sourceOf(ws, 'articles').schema.properties.labels.items['x-inverse'], 'articles');
	});

	test('with NO tags collection the sugar still answers — an array of plain strings', () => {
		const ws = workspace({ collections: { articles: simpleCollection({ storage: { suffix: 'article' } }) } });
		assert.equal(ws.dt('schema', 'add-field', 'articles', '--name', 'labels', '--type', 'tags').code, 0);
		const p = sourceOf(ws, 'articles').schema.properties.labels;
		assert.equal(p.type, 'array');
		assert.deepEqual(p.items, { type: 'string' });
	});

	test('a collection named for any other sugar word wins too', () => {
		const ws = workspace({ collections: {
			date: simpleCollection({ storage: { suffix: 'date-record' } }),
			articles: simpleCollection({ storage: { suffix: 'article' } }),
		} });
		assert.equal(ws.dt('schema', 'add-field', 'articles', '--name', 'when', '--type', 'date').code, 0);
		assert.equal(sourceOf(ws, 'articles').schema.properties.when['x-reference'], 'date');
	});
});
