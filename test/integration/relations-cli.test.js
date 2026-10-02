// Tier 2 — `dt relations` and `dt relations rebuild`.
//
// Rebuild is not a convenience: `check` prints "…: stale — run: dreamteamer relations rebuild
// <target>", so this verb is the other half of that sentence. A test that only proved rebuild
// changes bytes would leave the interesting claim unmeasured, which is why one case here vandalizes
// a mirror, asserts `check` FAILS, rebuilds, and asserts `check` passes — the round trip the message
// promises.
//
// Tier 2 rather than a unit test for the same reason as relations-store.test.js: the relation rows
// are read off the compiled descriptors, so nothing below is true of a hand-built descriptor map.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { workspace, simpleCollection, readFile, writeCollection, compileQuietly, dt as runDt, WS_MODULE } from '../helpers/ws.js';
import { load } from '../../src/yaml.js';

// The same four-collection cast as relations-store.test.js — one anchor plus the three
// cardinalities: many-to-one (recordings), one-to-one (summaries, via unique) and many-to-many
// (analyses). Copied rather than shared: test files run in separate processes, and a fixture module
// imported by two of them is read twice anyway, so the sharing would buy nothing and cost the
// ability to read either file on its own. A relation is declared once, on the mirror.
const coll = (suffix, fields = {}) => simpleCollection({
	storage: { suffix },
	fields: { name: { type: 'string', required: true }, ...fields, notes: { type: 'markdown', body: true } },
});
const MEETINGS = coll('meeting', {
	recordings: { type: 'recordings', many: true, mirror_of: 'meeting' },
	summary: { type: 'summaries', mirror_of: 'meeting' },
	analyses: { type: 'analyses', many: true, mirror_of: 'meetings' },
});
const RECORDINGS = coll('recording', { meeting: { type: 'meetings' } });
const SUMMARIES = coll('summary', { meeting: { type: 'meetings', unique: true } });
const ANALYSES = coll('analysis', { meetings: { type: 'meetings', many: true } });

const relWorkspace = (extra = {}) => workspace({
	collections: { meetings: MEETINGS, recordings: RECORDINGS, summaries: SUMMARIES, analyses: ANALYSES },
	...extra,
});

describe('dt relations', () => {
	test('lists the pairs', () => {
		const ws = relWorkspace();
		const res = ws.dt('relations');
		assert.equal(res.code, 0);
		assert.match(res.stdout, /recordings\.meeting\s+→\s+meetings\.recordings\[\]\s+m2o\s+restrict/);
		assert.match(res.stdout, /summaries\.meeting\s+→\s+meetings\.summary\s+o2o/);
	});

	test('a collection argument filters to its rows, on either side of the arrow', () => {
		// `recordings` is only ever an OWNER here, so a filter that matched targets alone would
		// return nothing and one that matched owners alone would miss the meetings view — both
		// sides are asserted rather than assumed.
		const ws = relWorkspace();
		const owner = ws.dt('relations', 'recordings');
		assert.equal(owner.code, 0);
		assert.match(owner.stdout, /recordings\.meeting/);
		assert.doesNotMatch(owner.stdout, /summaries\.meeting/);

		const target = ws.dt('relations', 'meetings');
		assert.match(target.stdout, /recordings\.meeting/);
		assert.match(target.stdout, /summaries\.meeting/);
		assert.match(target.stdout, /analyses\.meetings/);
	});

	test('--json emits the rows', () => {
		const ws = relWorkspace();
		const res = ws.dt('relations', 'summaries', '--json');
		assert.equal(res.code, 0);
		const rows = JSON.parse(res.stdout);
		assert.deepEqual(rows, [{
			owner: 'summaries', field: 'meeting', target: 'meetings', mirror: 'summary',
			list: false, unique: true, onDelete: 'restrict', kind: 'o2o',
		}]);
	});

	test('an unknown collection is refused, not reported as "no relations"', () => {
		// M4. `dt relations nosuch` printed "no two-way relations touch nosuch" and exited 0 — the
		// same answer a correctly-spelled collection with no relations gets, so a typo read as a
		// fact about the workspace. `rebuild` already validates; the read verb now does too.
		const ws = relWorkspace();
		const res = ws.dt('relations', 'nosuch');
		assert.equal(res.code, 1, res.stdout);
		assert.match(res.stderr, /unknown collection "nosuch"/);
	});

	test('a real collection with no relations still answers, at exit 0', () => {
		const ws = workspace({ collections: { widgets: coll('widget') } });
		const res = ws.dt('relations', 'widgets');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /no two-way relations touch widgets/);
	});

	test('rebuild repairs a vandalized mirror and reports the count', () => {
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('add', 'recordings', '--name', 'Cap', '--meeting', 'meetings/standup');
		const f = `${ws.root}/data/meetings/standup.meeting.md`;
		fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('recordings/cap', 'recordings/ghost'));
		const res = ws.dt('relations', 'rebuild', 'meetings');
		assert.equal(res.code, 0);
		assert.match(res.stdout, /rebuilt 1 record/);
		assert.match(readFile(ws.root, 'data/meetings/standup.meeting.md'), /recordings\/cap/);
		assert.equal(ws.dt('check').code, 0);
	});

	test('rebuild repairs exactly the state `check` complains about', () => {
		// the message check prints names this verb; if the two ever disagreed about what "stale"
		// means, the operator would be sent round a loop that never converges
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('add', 'recordings', '--name', 'Cap', '--meeting', 'meetings/standup');
		const f = `${ws.root}/data/meetings/standup.meeting.md`;
		fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('recordings/cap', 'recordings/ghost'));

		const before = ws.dt('check');
		assert.equal(before.code, 1);
		assert.match(before.stdout + before.stderr, /recordings: stale — run: dreamteamer relations rebuild meetings/);

		assert.equal(ws.dt('relations', 'rebuild', 'meetings').code, 0);
		const after = ws.dt('check');
		assert.equal(after.code, 0);
		assert.doesNotMatch(after.stdout + after.stderr, /stale/);
	});

	test('a duplicated FK: the store, check and rebuild all agree it is ONE entry', () => {
		// I2, end to end. `--meetings meetings/standup,meetings/standup` is accepted (an owner's
		// reference list declares no uniqueItems, and narrowing that is not this fix's business), the store
		// writes a set, and check compared against an expectation that appended blind — so check
		// called a correct mirror stale and the repair it names WROTE the duplicate. Three components,
		// one duplicated value, three answers.
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		assert.equal(ws.dt('add', 'analyses', '--name', 'A1', '--meetings', 'meetings/standup,meetings/standup').code, 0);
		const written = readFile(ws.root, 'data/meetings/standup.meeting.md');
		assert.equal(written.match(/analyses\/a1/g).length, 1, 'the store writes one entry');
		const before = ws.dt('check');
		assert.equal(before.code, 0, before.stdout + before.stderr);
		assert.equal(ws.dt('relations', 'rebuild', 'meetings').code, 0);
		assert.equal(readFile(ws.root, 'data/meetings/standup.meeting.md'), written, 'rebuild must not write the duplicate');
	});

	test('a hand-edited DUPLICATE in a generated mirror is NAMED as a duplicate', () => {
		// The generated array carries uniqueItems, so the engine can never write a duplicate there —
		// and one that arrives by hand is named for what it is by the schema, rather than only
		// reaching the operator as the vaguer "stale".
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('add', 'analyses', '--name', 'A1', '--meetings', 'meetings/standup');
		const f = `${ws.root}/data/meetings/standup.meeting.md`;
		fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('  - analyses/a1', '  - analyses/a1\n  - analyses/a1'));
		const res = ws.dt('check');
		assert.equal(res.code, 1);
		assert.match(res.stdout + res.stderr, /field analyses: .* must NOT have duplicate items/);
	});

	test('rebuild is idempotent — a second run rewrites nothing', () => {
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('add', 'recordings', '--name', 'Cap', '--meeting', 'meetings/standup');
		ws.dt('add', 'summaries', '--name', 'Sum', '--meeting', 'meetings/standup');
		ws.dt('add', 'analyses', '--name', 'An', '--meetings', 'meetings/standup');

		// the store already maintains these on write, so even the FIRST run has nothing to do
		const first = ws.dt('relations', 'rebuild', 'meetings');
		assert.equal(first.code, 0);
		assert.match(first.stdout, /rebuilt 0 records/);

		const before = readFile(ws.root, 'data/meetings/standup.meeting.md');
		const second = ws.dt('relations', 'rebuild', 'meetings');
		assert.match(second.stdout, /rebuilt 0 records/);
		assert.equal(readFile(ws.root, 'data/meetings/standup.meeting.md'), before);
	});

	test('a non-array mirror coerces the way check does — a scalar the loop cannot spread', () => {
		// `check` runs every record through ajv with `coerceTypes: 'array'` BEFORE the relation pass,
		// so it compares a coerced value; rebuild reads the raw parse. Left unmatched, the verb check
		// NAMES crashes on the very record it names ("(have ?? []) is not iterable"), mid-loop, after
		// earlier records were already written — and check stays permanently red.
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('add', 'recordings', '--name', 'Cap', '--meeting', 'meetings/standup');
		fs.writeFileSync(`${ws.root}/data/meetings/standup.meeting.md`, '---\nname: Standup\nrecordings: 5\n---\n');

		assert.equal(ws.dt('check').code, 1);
		const res = ws.dt('relations', 'rebuild', 'meetings');
		assert.equal(res.code, 0);
		assert.match(res.stdout, /rebuilt 1 record/);
		assert.equal(ws.dt('check').code, 0);
	});

	test('a scalar reference where a list belongs is NOT stale — check says so, and rebuild must agree', () => {
		// the opposite direction of the same mismatch: ajv coerces `recordings: recordings/cap` to a
		// one-element array, so check is green — and a rebuild that rewrote it would report work on a
		// record check considers correct
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('add', 'recordings', '--name', 'Cap', '--meeting', 'meetings/standup');
		const f = `${ws.root}/data/meetings/standup.meeting.md`;
		fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('recordings:\n  - recordings/cap', 'recordings: recordings/cap'));

		assert.equal(ws.dt('check').code, 0);
		const before = fs.readFileSync(f, 'utf8');
		const res = ws.dt('relations', 'rebuild', 'meetings');
		assert.equal(res.code, 0);
		assert.match(res.stdout, /rebuilt 0 records/);
		assert.equal(fs.readFileSync(f, 'utf8'), before);
	});

	test('--drop with no value is refused, not silently ignored', () => {
		// `--drop` last on the line parses as the boolean true; dropping it to null printed
		// "✔ rebuilt 0 records" at exit 0, which the operator reads as "the residue key is gone"
		const ws = relWorkspace();
		const res = ws.dt('relations', 'rebuild', 'meetings', '--drop');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /--drop needs a field name/);
	});

	test('an unparseable record is skipped and NAMED, and the loop still finishes', () => {
		// rebuild is the one reader that has already WRITTEN by the time a later record fails to
		// parse, so an abort here leaves a partial sweep behind an error naming no file at all
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Aaa');
		ws.dt('add', 'meetings', '--name', 'Zzz');
		ws.dt('add', 'recordings', '--name', 'Cap', '--meeting', 'meetings/zzz');
		const z = `${ws.root}/data/meetings/zzz.meeting.md`;
		fs.writeFileSync(z, fs.readFileSync(z, 'utf8').replace('recordings/cap', 'recordings/ghost'));
		fs.writeFileSync(`${ws.root}/data/meetings/aaa.meeting.md`, '---\nname: [unclosed\n---\n');

		const res = ws.dt('relations', 'rebuild', 'meetings');
		assert.equal(res.code, 0);
		assert.match(res.stdout + res.stderr, /aaa\.meeting\.md: parse error, skipped/);
		assert.match(res.stdout, /rebuilt 1 record/);
		assert.match(readFile(ws.root, 'data/meetings/zzz.meeting.md'), /recordings\/cap/);
	});

	test('rebuild takes the write lock, like every other write verb', () => {
		// several agents work in this tree at once: without the lock a concurrent `dt set` landing
		// mid-sweep is clobbered back to the pre-set mirror. Proved by leaving a STALE lock behind —
		// only a caller that actually acquires it reclaims and then releases the directory.
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		// ⚠ The lock lives in the GIT COMMON DIR, not in `.dreamteamer/` — it protects
		// `.git/index.lock` and `HEAD`, which every worktree of a repo shares, while the runtime
		// folder is per-checkout build output. Derived here rather than spelled out, so this test
		// follows the lock instead of pinning a path it does not own.
		const commonDir = path.resolve(ws.root, execFileSync('git', ['rev-parse', '--git-common-dir'],
			{ cwd: ws.root, encoding: 'utf8' }).trim());
		const lock = path.join(commonDir, '.dreamteamer-write-lock');
		fs.mkdirSync(lock, { recursive: true });
		const stale = (Date.now() - 60_000) / 1000; // older than the 30s steal threshold
		fs.utimesSync(lock, stale, stale);

		const res = ws.dt('relations', 'rebuild', 'meetings');
		assert.equal(res.code, 0);
		assert.equal(fs.existsSync(lock), false, 'the lock was neither taken nor released');
	});

	test('rebuild --drop removes a stale ex-mirror key', () => {
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		const f = `${ws.root}/data/meetings/standup.meeting.md`;
		fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('---\nname:', '---\ncaptures:\n  - recordings/old\nname:'));
		const res = ws.dt('relations', 'rebuild', 'meetings', '--drop', 'captures');
		assert.equal(res.code, 0);
		assert.doesNotMatch(readFile(ws.root, 'data/meetings/standup.meeting.md'), /captures/);
	});

	test('rebuild refuses the two shapes it must never rewrite', () => {
		// compile refuses a mirror onto either, so the relation loop would simply be empty and look
		// harmless — but --drop writes whether or not a relation targets the collection, and
		// `serialize` has no binary branch: it would replace an SVG with frontmatter.
		const files = workspace({ collections: { pics: { description: 'x', storage: { format: 'binary', suffix: 'pic' }, ids: { pattern: '^[a-z/-]+$' }, fields: {} } } });
		const onFiles = files.dt('relations', 'rebuild', 'pics', '--drop', 'captures');
		assert.equal(onFiles.code, 1);
		assert.match(onFiles.stderr, /stored as `format: binary` — .+will not rewrite it/s);

		// a runtime-based collection's records are build artifacts; its source lives elsewhere
		const onRuntime = files.dt('relations', 'rebuild', 'skills', '--drop', 'captures');
		assert.equal(onRuntime.code, 1);
		assert.match(onRuntime.stderr, /is a compiled source/);
	});

	test('rebuild --drop refuses a field the schema declares', () => {
		const ws = relWorkspace();
		const res = ws.dt('relations', 'rebuild', 'meetings', '--drop', 'recordings');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /is a live field/);
	});
});

describe('rm-field on a module-shipped collection', () => {
	/** A workspace whose collection `patients` is shipped by a module other than the workspace
	 *  module — the ordinary case: a workspace's domain collections almost always live in a module.
	 *  `visits` (the workspace module's) references it. */
	const withModule = () => {
		const ws = workspace({ compile: false });
		const mod = path.join(ws.root, 'modules', 'clinic');
		fs.mkdirSync(path.join(mod, 'collections'), { recursive: true });
		fs.writeFileSync(path.join(mod, 'package.json'), JSON.stringify({ name: 'clinic', version: '1.0.0', dreamteamer: {} }, null, '\t'));
		fs.writeFileSync(path.join(mod, 'collections', 'patients.collection.yaml'),
			'name: patients\ndescription: A patient.\nids:\n  from: "{{ name | slug }}"\nstorage:\n  suffix: patient\n'
			+ 'fields:\n  name:\n    type: string\n    required: true\n'
			+ '  age:\n    type: integer\n'
			+ '  notes:\n    type: markdown\n    body: true\n');
		writeCollection(ws.root, 'visits', coll('visit', { patient: { type: 'patients' } }));
		// the referencing module has to declare the dependency it points across
		const pkgFile = path.join(ws.root, 'modules', WS_MODULE, 'package.json');
		const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
		pkg.dreamteamer.dependencies = ['clinic'];
		fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, '\t'));
		compileQuietly(ws.ws);
		return ws;
	};

	// ⚠ THIS USED TO ASSERT THE DEFECT. `patients` ships from an INLINE module and
	// the verb refused it as "module-shipped", because it resolved its write target from the workspace
	// module. Inline sources sit under the same git history as everything else, so a field verb now
	// edits clinic's own descriptor — see `collectionSourceFile`. The fallthrough refusal survives for
	// a source the workspace genuinely cannot rewrite, which is what `npm install` erases.
	test('a real own field in an inline module is edited THERE, not refused', () => {
		const ws = withModule();
		const res = runDt(ws.root, 'rm-field', 'patients', '--name', 'age');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		const owned = load(readFile(ws.root, 'modules/clinic/collections/patients.collection.yaml'));
		assert.equal(owned.fields.age, undefined);
	});

	test('a real inherited field the workspace cannot rewrite is still refused', () => {
		const ws = withModule();
		// `repos` ships from node_modules/dreamteamer, which the next `npm install` overwrites.
		const res = runDt(ws.root, 'rm-field', 'repos', '--name', 'path');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /cannot rewrite/);
	});
});

describe('dropping a relation takes its generated values with it', () => {
	/** meetings ⟷ recordings, one linked pair, so the mirror actually holds a value. */
	const linked = () => {
		const ws = workspace({
			collections: {
				meetings: coll('meeting', { recordings: { type: 'recordings', many: true, mirror_of: 'meeting' } }),
				recordings: coll('recording', { meeting: { type: 'meetings' } }),
			},
		});
		assert.equal(ws.dt('add', 'meetings', '--name', 'Kickoff').code, 0);
		assert.equal(ws.dt('add', 'recordings', '--name', 'Cap One', '--meeting', 'meetings/kickoff').code, 0);
		assert.match(readFile(ws.root, 'data/meetings/kickoff.meeting.md'), /recordings\/cap-one/);
		return ws;
	};

	test('rm-field on the owning foreign key does the same', () => {
		const ws = linked();
		const res = ws.dt('rm-field', 'recordings', '--name', 'meeting');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /dropped the generated meetings\.recordings value from 1 meetings record/);
		assert.doesNotMatch(readFile(ws.root, 'data/meetings/kickoff.meeting.md'), /recordings:/);
		// ⚠ THE OWNER'S OWN VALUE GOES TOO. Left behind, the key survives in a schema that no longer
		// declares it, so `check` reports an unknown field and the store refuses every later write to
		// that record — a collection you can read and not WRITE. Removing a field is an explicit
		// destructive schema act, the values are one `git show HEAD~1` away because this lands in the
		// same commit, and the count is REPORTED rather than silent.
		assert.doesNotMatch(readFile(ws.root, 'data/recordings/cap-one.recording.md'), /meeting:/);
		assert.match(res.stdout, /cleared its values from 1 recordings record/);
		assert.equal(ws.dt('check').code, 0, 'and the collection is writable again, which is the point');
		assert.equal(ws.dt('set', 'recordings/cap-one', 'name=Cap Two').code, 0);
	});

	test('add-field sweeps nothing — it cannot remove a relation it is creating', () => {
		const ws = linked();
		const res = ws.dt('add-field', 'recordings', '--name', 'duration', '--type', 'number');
		assert.equal(res.code, 0, res.stderr);
		assert.doesNotMatch(res.stdout, /dropped/);
		assert.match(readFile(ws.root, 'data/meetings/kickoff.meeting.md'), /recordings\/cap-one/);
	});
});

// ── rm-field on a relation's two sides ──────────────────────────────────────────────────────
//
// A relation is declared once, on the mirror, so removing the mirror field from the collection that
// declares it removes the relation; and an edit to the owner must not write compile's defaults back
// into the owner's source.
describe('rm-field and the declaring side of a relation', () => {
	const declared = () => {
		const ws = workspace({
			collections: {
				meetings: coll('meeting', { summary: { type: 'summaries', mirror_of: 'meeting' } }),
				summaries: coll('summary', { meeting: { type: 'meetings', unique: true } }),
			},
		});
		assert.equal(ws.dt('add', 'meetings', '--name', 'Kickoff').code, 0);
		assert.equal(ws.dt('add', 'summaries', '--name', 'S1', '--meeting', 'meetings/kickoff').code, 0);
		assert.match(readFile(ws.root, 'data/meetings/kickoff.meeting.md'), /summary: summaries\/s1/);
		return ws;
	};

	test('a mirror is removed from the collection that declares it, and its values go with it', () => {
		const ws = declared();
		const res = ws.dt('rm-field', 'meetings', '--name', 'summary');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.equal(
			load(readFile(ws.root, 'modules/default/collections/meetings.collection.yaml')).fields.summary,
			undefined);
		// the declaration WAS the relation, so removing it removes the relation
		assert.equal(ws.dt('relations', '--json').stdout.trim(), '[]');
		// the value went with the field, so the collection is writable again
		assert.doesNotMatch(readFile(ws.root, 'data/meetings/kickoff.meeting.md'), /summary:/);
		assert.match(res.stdout, /cleared its values from 1 meetings record/);
		assert.equal(ws.dt('check').code, 0, ws.dt('check').stdout);
		assert.equal(ws.dt('set', 'meetings/kickoff', 'name=Kickoff 2').code, 0);
	});

	test('an ordinary edit on the OWNER writes back only what was authored', () => {
		// `previous` must come off the AUTHORED field, not the compiled one: the compiled field carries
		// what compile supplied (`title`, `on_delete: restrict`), and carrying those "forward" writes
		// defaults into the source as if the author had chosen them.
		const ws = declared();
		const res = ws.dt('set-field', 'summaries', '--name', 'meeting', '--description', 'the call');
		assert.equal(res.code, 0, res.stderr);
		const src = load(readFile(ws.root, 'modules/default/collections/summaries.collection.yaml')).fields.meeting;
		assert.equal(src.description, 'the call');
		assert.equal(src.type, 'meetings', 'the authored reference survives the edit');
		assert.equal(src.unique, true, 'and so does the authored uniqueness the scalar mirror needs');
		assert.equal(src.on_delete, undefined, 'compile SUPPLIED this; writing it back makes a default look authored');
		assert.equal(src.title, undefined, 'and this');
		assert.equal(compileQuietly(ws.ws).code, 0);
	});
});

// ── rm-field must not leave a collection you can read and cannot write ──────────────────────
describe('rm-field clears the values it orphans', () => {
	const withVenue = () => workspace({ collections: { meetings: coll('meeting', { venue: { type: 'string' } }) } });
	const populated = () => {
		const ws = withVenue();
		for (const n of ['Kickoff', 'Retro']) assert.equal(ws.dt('add', 'meetings', '--name', n, '--venue', 'Room 3').code, 0);
		return ws;
	};

	test('a populated NON-relation field: values cleared, count reported, collection writable', () => {
		// Measured before: the key stayed in every record, so `check` reported `unknown field` and the
		// store refused the next write to each of them — with no repair a record write could reach
		// (`venue=` writes `venue: []`, which is still the key). The only fix was
		// `relations rebuild meetings --drop venue`, a verb whose name says "relations" for a field
		// that has nothing to do with them.
		const ws = populated();
		const res = ws.dt('rm-field', 'meetings', '--name', 'venue');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /cleared its values from 2 meetings records/);
		assert.match(res.stdout, /git show HEAD~1/, 'a destructive act names where the values went');
		for (const id of ['kickoff', 'retro']) {
			assert.doesNotMatch(readFile(ws.root, `data/meetings/${id}.meeting.md`), /venue:/);
		}
		assert.equal(ws.dt('check').code, 0, ws.dt('check').stdout);
		assert.equal(ws.dt('set', 'meetings/kickoff', 'name=Kickoff 2').code, 0, 'the point: writable again');
	});

	test('the values and the schema land in ONE commit', () => {
		const ws = populated();
		assert.equal(ws.dt('commit').code, 0);
		assert.equal(ws.dt('rm-field', 'meetings', '--name', 'venue').code, 0);
		const stat = ws.git(['show', '--stat', '--oneline', 'HEAD']);
		assert.match(stat, /data\/meetings\/kickoff\.meeting\.md/);
		assert.match(stat, /modules\/default\/collections\/meetings\.collection\.yaml/);
		assert.equal(ws.git(['status', '--porcelain', 'data', 'modules']).trim(), '', 'nothing left pending');
	});

	test('an UNPOPULATED field reports no clearing, and says nothing about records', () => {
		const ws = withVenue();
		assert.equal(ws.dt('add', 'meetings', '--name', 'Kickoff').code, 0);
		const res = ws.dt('rm-field', 'meetings', '--name', 'venue');
		assert.equal(res.code, 0, res.stderr);
		assert.doesNotMatch(res.stdout, /cleared/);
	});

	test('removing the BODY field leaves the prose alone', () => {
		// ⚠ The one field this cannot and must not clear. With the field gone `bodyFieldOf(d)` no longer
		// names it, so the prose is never parsed into `fields` — nothing matches, nothing is rewritten,
		// and the text stays as an ordinary Markdown body no schema field claims. Asserted so the
		// behaviour is pinned rather than accidental: a sweep that reached the body would delete a
		// record's whole content on a schema edit.
		const ws = workspace({ collections: { meetings: coll('meeting') } });
		assert.equal(ws.dt('add', 'meetings', '--name', 'Kickoff', '--notes', 'the prose that must survive').code, 0);
		const res = ws.dt('rm-field', 'meetings', '--name', 'notes');
		assert.equal(res.code, 0, res.stderr);
		assert.match(readFile(ws.root, 'data/meetings/kickoff.meeting.md'), /the prose that must survive/);
		assert.equal(ws.dt('check').code, 0, ws.dt('check').stdout);
	});

	test('a rename is not a removal — nothing is cleared', () => {
		// `collections rename` moves a descriptor and its records; no field is removed, so no value may
		// be. The sweep is scoped to the field actually named, never to a graph diff (rule 6).
		const ws = populated();
		assert.equal(ws.dt('rename', 'collections/meetings', 'calls').code, 0);
		assert.match(readFile(ws.root, 'data/calls/kickoff.call.md'), /venue: Room 3/);
		assert.equal(ws.dt('check').code, 0);
	});
});
