// Tier 2 — a generated mirror field is ENGINE-OWNED. It is on the target's schema, so it looks
// writable to anyone reading the descriptor, and `readOnly` is presentation rather than a gate: ajv
// does not enforce it. Without a guard, `dt set meetings/standup recordings=...` lands a value the
// store is about to recompute from the owning side, and the two silently disagree.
//
// So the store refuses, and the refusal is only worth anything if it names the write that WOULD have
// worked — the owning field, on the owning collection, pointing back at this record. That sentence
// is the assertion here.
//
// Tier 2 rather than a unit test because the thing under test is the compiled artifact: the mirror
// only exists after compile stamps it, and only the real CLI proves the message reaches stderr with
// a non-zero exit rather than being swallowed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { workspace, simpleCollection, readFile } from '../helpers/ws.js';

// The same four-collection cast as relations-compile.test.js — one anchor plus the three
// cardinalities: many-to-one (recordings), one-to-one (summaries, via x-unique) and many-to-many
// (analyses). Copied rather than shared: test files run in separate processes, and a fixture module
// imported by two of them is read twice anyway, so the sharing would buy nothing and cost the
// ability to read either file on its own.
const MEETINGS = simpleCollection({ storage: { suffix: 'meeting' } });

const RECORDINGS = simpleCollection({
	storage: { suffix: 'recording' },
	schema: {
		type: 'object',
		required: ['name'],
		properties: {
			name: { type: 'string' },
			meeting: { type: 'string', 'x-reference': 'meetings', 'x-inverse': 'recordings' },
		},
	},
});

const SUMMARIES = simpleCollection({
	storage: { suffix: 'summary' },
	schema: {
		type: 'object',
		required: ['name'],
		properties: {
			name: { type: 'string' },
			meeting: { type: 'string', 'x-reference': 'meetings', 'x-unique': true, 'x-inverse': 'summary' },
		},
	},
});

const ANALYSES = simpleCollection({
	storage: { suffix: 'analysis' },
	schema: {
		type: 'object',
		required: ['name'],
		properties: {
			name: { type: 'string' },
			// authored on the PROPERTY: normalizeRelationKeywords hoists it onto `items`, which is
			// where every relation consumer reads it from
			meetings: { type: 'array', 'x-inverse': 'analyses', items: { type: 'string', 'x-reference': 'meetings' } },
		},
	},
});

const relWorkspace = (extra = {}) => workspace({
	collections: { meetings: MEETINGS, recordings: RECORDINGS, summaries: SUMMARIES, analyses: ANALYSES },
	...extra,
});

describe('mirror fields are engine-owned', () => {
	test('dt set on a mirror is refused with the owning-side command', () => {
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		const res = ws.dt('set', 'meetings/standup', 'recordings=recordings/x');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /recordings is generated from recordings\.meeting — set that instead: dreamteamer set recordings\/<id> meeting=meetings\/standup/);
	});

	test('a scalar (unique) mirror refuses in exactly the same shape', () => {
		// the array mirror above and this scalar one are the two shapes the message has to render;
		// nothing in the sentence varies with cardinality, and that is the point of checking both
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		const res = ws.dt('set', 'meetings/standup', 'summary=summaries/x');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /summary is generated from summaries\.meeting — set that instead: dreamteamer set summaries\/<id> meeting=meetings\/standup/);
	});

	test('dt add naming a mirror is refused too, and nothing lands', () => {
		// `add` has no id yet, so the suggested command carries the placeholder — the refusal still
		// has to name the owning field, because that is the only actionable half
		const ws = relWorkspace();
		const res = ws.dt('add', 'meetings', '--name', 'Kickoff', '--analyses', 'analyses/x');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /analyses is generated from analyses\.meetings — set that instead: dreamteamer set analyses\/<id> meetings=meetings\/<id>/);
		assert.match(res.stderr, /nothing was written/);
		assert.equal(readFile(ws.root, 'data/meetings/kickoff.meeting.md'), null);
	});

	test('the OWNING field is untouched by the guard', () => {
		// the guard is scoped to generated mirrors on the collection being written; the foreign key
		// that generates them is an ordinary writable field and must stay one
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		assert.equal(ws.dt('add', 'recordings', '--name', 'Cut', '--meeting', 'meetings/standup').code, 0);
		assert.equal(ws.dt('set', 'recordings/cut', 'meeting=meetings/standup').code, 0);
	});
});

// The other half of the same bargain. `refuseMirrorWrites` above says the mirror is not yours to
// write; these say the ENGINE writes it — on the same tick, in the same commit, or not at all. The
// standing assertion in every one of them is `dt check` exiting 0, because check recomputes the
// mirror from the owners and a store that maintains mirrors incorrectly is indistinguishable from
// one that does not maintain them at all: both leave `<mirror>: stale` behind.
describe('the store maintains mirrors', () => {
	test('add with an FK writes the mirror, sorted', () => {
		// SORTED, and asserted with two records added in the wrong order — `expectedMirrors` sorts,
		// so a store that appends in arrival order passes `check` only by luck of the alphabet.
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		assert.equal(ws.dt('add', 'recordings', '--name', 'B', '--meeting', 'meetings/standup').code, 0);
		assert.equal(ws.dt('add', 'recordings', '--name', 'A', '--meeting', 'meetings/standup').code, 0);
		assert.match(readFile(ws.root, 'data/meetings/standup.meeting.md'), /recordings:\n  - recordings\/a\n  - recordings\/b/);
		assert.equal(ws.dt('check').code, 0);
	});

	test('the owner and the mirror land in ONE commit', () => {
		// The whole point of maintaining mirrors in the store rather than in a later sweep: two files
		// change, and a reader of the history must never see a commit where only one of them did.
		const ws = relWorkspace({ pkg: { 'auto-commit': true } });
		ws.dt('add', 'meetings', '--name', 'Standup');
		assert.equal(ws.dt('add', 'recordings', '--name', 'Cut', '--meeting', 'meetings/standup').code, 0);
		const files = ws.git(['show', '--name-only', '--pretty=format:', 'HEAD']).split('\n').filter(Boolean).sort();
		assert.deepEqual(files, ['data/meetings/standup.meeting.md', 'data/recordings/cut.recording.md']);
	});

	test('set moving an FK detaches from the old target and attaches to the new', () => {
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'One');
		ws.dt('add', 'meetings', '--name', 'Two');
		ws.dt('add', 'recordings', '--name', 'Cap', '--meeting', 'meetings/one');
		assert.equal(ws.dt('set', 'recordings/cap', 'meeting=meetings/two').code, 0);
		assert.doesNotMatch(readFile(ws.root, 'data/meetings/one.meeting.md'), /recordings\/cap/);
		assert.match(readFile(ws.root, 'data/meetings/two.meeting.md'), /recordings\/cap/);
		assert.equal(ws.dt('check').code, 0);
	});

	test('a list FK mirrors onto every target it names, and drops the one it stops naming', () => {
		// The m2m shape: the owner side is an array too, so one write touches TWO targets. A store
		// that reads `before`/`after` as scalars silently maintains only the first.
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'One');
		ws.dt('add', 'meetings', '--name', 'Two');
		assert.equal(ws.dt('add', 'analyses', '--name', 'Deep', '--meetings', 'meetings/one,meetings/two').code, 0);
		assert.match(readFile(ws.root, 'data/meetings/one.meeting.md'), /analyses:\n  - analyses\/deep/);
		assert.match(readFile(ws.root, 'data/meetings/two.meeting.md'), /analyses:\n  - analyses\/deep/);
		assert.equal(ws.dt('set', 'analyses/deep', 'meetings=meetings/two').code, 0);
		assert.doesNotMatch(readFile(ws.root, 'data/meetings/one.meeting.md'), /analyses/);
		assert.match(readFile(ws.root, 'data/meetings/two.meeting.md'), /analyses\/deep/);
		assert.equal(ws.dt('check').code, 0);
	});

	test('clearing the FK clears the mirror — the key goes, it does not go empty', () => {
		// `[]` and absent read the same to `check`, but only one of them is what a hand-written record
		// looks like, and a file full of empty keys is the derived state leaking into the source.
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('add', 'summaries', '--name', 'One', '--meeting', 'meetings/standup');
		ws.dt('add', 'recordings', '--name', 'Cap', '--meeting', 'meetings/standup');
		assert.equal(ws.dt('set', 'summaries/one', 'meeting=').code, 0);
		assert.equal(ws.dt('set', 'recordings/cap', 'meeting=').code, 0);
		const m = readFile(ws.root, 'data/meetings/standup.meeting.md');
		assert.doesNotMatch(m, /summary:/);
		assert.doesNotMatch(m, /recordings:/);
		assert.equal(ws.dt('check').code, 0);
	});

	test('a unique FK refuses a second owner naming the taken target', () => {
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('add', 'summaries', '--name', 'One', '--meeting', 'meetings/standup');
		const res = ws.dt('add', 'summaries', '--name', 'Two', '--meeting', 'meetings/standup');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /already has a summary \(summaries\/one\)/);
	});

	test('the refused duplicate leaves NOTHING behind', () => {
		// The rollback assertion, and the reason the mirror pass runs inside the write lock with the
		// owner file restorable: the conflict is only discoverable on the TARGET, which is read after
		// the owner has been written. "nothing was written" has to survive that ordering.
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('add', 'summaries', '--name', 'One', '--meeting', 'meetings/standup');
		const before = readFile(ws.root, 'data/meetings/standup.meeting.md');
		assert.equal(ws.dt('add', 'summaries', '--name', 'Two', '--meeting', 'meetings/standup').code, 1);
		assert.equal(readFile(ws.root, 'data/summaries/two.summary.md'), null);
		assert.equal(readFile(ws.root, 'data/meetings/standup.meeting.md'), before);
		assert.equal(ws.dt('check').code, 0);
	});

	test('a refused set leaves the owner at its previous value', () => {
		// Same rollback, the other verb: `set` restores bytes rather than removing a file, so it is a
		// different code path and fails differently — an owner left pointing at the taken target while
		// the target still names the first claimant is exactly the stale mirror check reports.
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'One');
		ws.dt('add', 'meetings', '--name', 'Two');
		ws.dt('add', 'summaries', '--name', 'First', '--meeting', 'meetings/one');
		ws.dt('add', 'summaries', '--name', 'Second', '--meeting', 'meetings/two');
		const res = ws.dt('set', 'summaries/second', 'meeting=meetings/one');
		assert.equal(res.code, 1);
		assert.match(readFile(ws.root, 'data/summaries/second.summary.md'), /meeting: meetings\/two/);
		assert.match(readFile(ws.root, 'data/meetings/two.meeting.md'), /summary: summaries\/second/);
		assert.equal(ws.dt('check').code, 0);
	});
});
