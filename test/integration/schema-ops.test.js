// Tier 2 — the meta verbs, through the CLI, including the namespace flag.
//
// These write SOURCES behind a real compile gate, which is the property worth testing: a schema op
// that produced an uncompilable descriptor used to be discoverable only on the next command.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { workspace, simpleCollection, readFile } from '../helpers/ws.js';
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
		const ws = bare();
		for (const flag of [['--inverse'], ['--unique'], ['--on-delete', 'set-null'], ['--many'], ['--mirror-of', 'meetings.x']]) {
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
