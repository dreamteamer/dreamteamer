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
import fs from 'node:fs';
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
			notes: { type: 'string', format: 'markdown', 'x-body': true }, // analyses mirror onto this
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

// The four ways a maintained mirror was found to be maintainable WRONGLY. Each of these was
// reproduced through the real CLI before it was a test; none of them is hypothetical.
describe('mirror maintenance holds at the edges', () => {
	test('revert moves the mirrors with the FK it restores', () => {
		// `revert` is SET-shaped — it changes an owner's foreign key — so it owes the same mirror
		// maintenance. It reached disk through its own atomicWrite and skipped the pass entirely,
		// which left BOTH targets stale: the old one never got the link back, the new one kept a link
		// the owner no longer claims.
		const ws = relWorkspace({ pkg: { 'auto-commit': true } });
		ws.dt('add', 'meetings', '--name', 'One');
		ws.dt('add', 'meetings', '--name', 'Two');
		ws.dt('add', 'recordings', '--name', 'Cap', '--meeting', 'meetings/one');
		const at = ws.git(['rev-parse', 'HEAD']);
		assert.equal(ws.dt('set', 'recordings/cap', 'meeting=meetings/two').code, 0);
		const res = ws.dt('revert', 'recordings/cap', '--hash', at);
		assert.equal(res.code, 0, res.stderr);
		assert.match(readFile(ws.root, 'data/meetings/one.meeting.md'), /recordings\/cap/);
		assert.doesNotMatch(readFile(ws.root, 'data/meetings/two.meeting.md'), /recordings\/cap/);
		const check = ws.dt('check');
		assert.equal(check.code, 0, check.stdout);
	});

	test('a BARE foreign key on disk still detaches', () => {
		// `before` comes straight off disk and `after` has been through qualifyBareRefs, so a record
		// carrying `meeting: standup` (hand-edited, or written before namespaces) diffed as a detach of
		// "standup" — which parses as nothing and is skipped — plus an attach of "meetings/standup".
		// The old target kept the link forever, and a green `dt set` was what created the staleness.
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('add', 'meetings', '--name', 'Retro');
		ws.dt('add', 'recordings', '--name', 'Cap', '--meeting', 'meetings/standup');
		const f = `${ws.root}/data/recordings/cap.recording.md`;
		fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('meeting: meetings/standup', 'meeting: standup'));
		assert.equal(ws.dt('set', 'recordings/cap', 'meeting=meetings/retro').code, 0);
		assert.doesNotMatch(readFile(ws.root, 'data/meetings/standup.meeting.md'), /recordings\/cap/);
		assert.match(readFile(ws.root, 'data/meetings/retro.meeting.md'), /recordings\/cap/);
		const check = ws.dt('check');
		assert.equal(check.code, 0, check.stdout);
	});

	test('attaching to a target that already names this owner does not double the entry', () => {
		// The dedupe on attach, which the reviewer had to prove reachable: hand-write the mirror while
		// the owner's FK is empty (a half-finished edit, or one side of a merge), then set the FK. The
		// attach finds itself already listed, and a plain append would leave two copies — which check
		// reads as stale, so the write that was meant to REPAIR the record breaks it instead.
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('add', 'recordings', '--name', 'Cap');
		const f = `${ws.root}/data/meetings/standup.meeting.md`;
		fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^---\n/, '---\nrecordings:\n  - recordings/cap\n'));
		assert.equal(ws.dt('set', 'recordings/cap', 'meeting=meetings/standup').code, 0);
		assert.match(readFile(ws.root, 'data/meetings/standup.meeting.md'), /recordings:\n  - recordings\/cap\n(?!  - )/);
		const check = ws.dt('check');
		assert.equal(check.code, 0, check.stdout);
	});
});

// Partitioned ids on a SELF-referencing collection, which is what makes the next case reproducible
// rather than a matter of filesystem timing: `ids()` keys its memo on the mtime of the collection's
// TOP directory, and a record written into an existing `data/people/core/` moves neither that mtime
// nor HEAD. So the entry cached during a refused write survives the rollback — deterministically.
const PEOPLE = {
	id: { generate: '{{ team }}/{{ name | slug }}' },
	storage: { suffix: 'person' },
	schema: {
		type: 'object',
		required: ['name', 'team'],
		properties: {
			name: { type: 'string' },
			team: { type: 'string' },
			notes: { type: 'string', format: 'markdown', 'x-body': true }, // a mirror target needs one
			mentor: { type: 'string', 'x-reference': 'people', 'x-unique': true, 'x-inverse': 'mentee' },
		},
	},
};

describe('a refused write leaves no trace in memory either', () => {
	test('the id cache does not keep the record the rollback removed', () => {
		// In-process, through the Store, because that is where the damage lives: the file is gone from
		// disk and a fresh Store agrees, but THIS Store still lists the id — so the next write's
		// checkRefs sees a record that does not exist and lands a dangling reference from a verb that
		// reported success.
		const ws = workspace({ collections: { people: PEOPLE } });
		ws.store.add('people', { name: 'Ada', team: 'core' });
		ws.store.add('people', { name: 'Bo', team: 'core', mentor: 'people/core/ada' });
		assert.throws(() => ws.store.add('people', { name: 'Cy', team: 'core', mentor: 'people/core/ada' }), /already has a mentee/);
		assert.equal(readFile(ws.root, 'data/people/core/cy.person.md'), null); // the disk is right
		assert.equal(ws.store.ids('people').has('core/cy'), false); // …and so must the memo be
	});
});

// `rm` predates relations, and its guard is a TEXT SCAN: any record file whose bytes contain
// `<collection>/<id>` refuses the removal. That was right when every inbound reference was somebody's
// hand-written data. It is wrong the moment the engine writes references of its own — a record's own
// mirror entries are engine-managed, so the guard refused a removal on the strength of a value it had
// written itself, and the only way out was `--force`, which leaves the mirror dangling.
//
// So `rm` splits inbound references in three: MINE (mirror entries my FKs put on their targets —
// detached), THEIRS UNDER A RULE (an owner's FK pointing at me, resolved by `x-on-delete`) and
// THEIRS (everything else — still refused). Each case below is one of the three, and every one of
// them closes on `dt check`, because a removal that leaves a stale mirror behind is indistinguishable
// from one that never maintained mirrors at all.
describe('rm and relations', () => {
	test('removing an owner detaches it from the mirror instead of refusing', () => {
		// The regression in one line: meetings/standup names recordings/cap ONLY because the store put
		// it there, so refusing on that entry is the engine refusing its own bookkeeping.
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('add', 'recordings', '--name', 'Cap', '--meeting', 'meetings/standup');
		const res = ws.dt('rm', 'recordings/cap');
		assert.equal(res.code, 0, res.stderr); // the mirror hit must NOT refuse
		assert.doesNotMatch(readFile(ws.root, 'data/meetings/standup.meeting.md'), /recordings\/cap/);
		const check = ws.dt('check');
		assert.equal(check.code, 0, check.stdout);
	});

	test('removing a target with restrict owners refuses, naming them', () => {
		// The other direction, and the default: recordings.meeting has no `x-on-delete`, so it is
		// `restrict` — the owner's foreign key is real data and only its author can decide what it
		// should say instead.
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('add', 'recordings', '--name', 'Cap', '--meeting', 'meetings/standup');
		const res = ws.dt('rm', 'meetings/standup');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /referenced by/);
		assert.match(res.stderr, /recordings\/cap/);
		assert.match(readFile(ws.root, 'data/recordings/cap.recording.md'), /meeting: meetings\/standup/);
		const check = ws.dt('check');
		assert.equal(check.code, 0, check.stdout);
	});

	test('set-null clears the FK on owners when the target goes', () => {
		const SN = structuredClone(ANALYSES);
		SN.schema.properties.meetings.items['x-on-delete'] = 'set-null';
		const ws = workspace({ collections: { meetings: MEETINGS, analyses: SN } });
		ws.dt('add', 'meetings', '--name', 'One');
		ws.dt('add', 'meetings', '--name', 'Two');
		ws.dt('add', 'analyses', '--name', 'Arc', '--meetings', 'meetings/one,meetings/two');
		const res = ws.dt('rm', 'meetings/one');
		assert.equal(res.code, 0, res.stderr);
		const a = readFile(ws.root, 'data/analyses/arc.analysis.md');
		assert.doesNotMatch(a, /meetings\/one/);
		assert.match(a, /meetings\/two/);
		const check = ws.dt('check');
		assert.equal(check.code, 0, check.stdout);
	});

	test('a set-null ARRAY FK loses only the element that went', () => {
		// Three elements rather than two, and the one removed is in the MIDDLE: a set-null that
		// replaces the array wholesale, or clears the key because one member matched, passes the
		// two-element case by accident.
		const SN = structuredClone(ANALYSES);
		SN.schema.properties.meetings.items['x-on-delete'] = 'set-null';
		const ws = workspace({ collections: { meetings: MEETINGS, analyses: SN } });
		for (const n of ['One', 'Two', 'Three']) ws.dt('add', 'meetings', '--name', n);
		ws.dt('add', 'analyses', '--name', 'Arc', '--meetings', 'meetings/one,meetings/two,meetings/three');
		assert.equal(ws.dt('rm', 'meetings/two').code, 0);
		const a = readFile(ws.root, 'data/analyses/arc.analysis.md');
		assert.match(a, /meetings\/one/);
		assert.match(a, /meetings\/three/);
		assert.doesNotMatch(a, /meetings\/two/);
		const check = ws.dt('check');
		assert.equal(check.code, 0, check.stdout);
	});

	test('a set-null SCALAR FK loses the key, not just the value', () => {
		// `meeting:` with nothing after it is not a cleared reference, it is `null` — which ajv reads
		// as a type error the next time anything writes the record. Absent is the only correct shape,
		// and it is the same rule the mirror side already follows.
		const SR = structuredClone(RECORDINGS);
		SR.schema.properties.meeting['x-on-delete'] = 'set-null';
		const ws = workspace({ collections: { meetings: MEETINGS, recordings: SR } });
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('add', 'recordings', '--name', 'Cap', '--meeting', 'meetings/standup');
		assert.equal(ws.dt('rm', 'meetings/standup').code, 0);
		const r = readFile(ws.root, 'data/recordings/cap.recording.md');
		assert.doesNotMatch(r, /meeting:/);
		assert.equal(ws.dt('set', 'recordings/cap', 'name=Cap2').code, 0); // still a valid record
		const check = ws.dt('check');
		assert.equal(check.code, 0, check.stdout);
	});

	test('--force still removes a restricted target, and says what it left dangling', () => {
		// The escape hatch is unchanged: `--force` is how you remove something whose referrers you
		// intend to fix by hand, and it has to REPORT the damage rather than hide it.
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('add', 'recordings', '--name', 'Cap', '--meeting', 'meetings/standup');
		const res = ws.dt('rm', 'meetings/standup', '--force');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /1 inbound reference\(s\) left dangling/);
		assert.equal(readFile(ws.root, 'data/meetings/standup.meeting.md'), null);
		assert.equal(ws.dt('check').code, 1); // …and it is a dangling reference, which check reports
	});

	test('the whole removal is ONE commit — the record and every reference the engine moved', () => {
		// Same bargain as add/set: a history where the target is gone but its owners still name it is
		// a commit that never held a consistent workspace.
		const SN = structuredClone(ANALYSES);
		SN.schema.properties.meetings.items['x-on-delete'] = 'set-null';
		const ws = workspace({ collections: { meetings: MEETINGS, analyses: SN }, pkg: { 'auto-commit': true } });
		ws.dt('add', 'meetings', '--name', 'One');
		ws.dt('add', 'analyses', '--name', 'Arc', '--meetings', 'meetings/one');
		assert.equal(ws.dt('rm', 'meetings/one').code, 0);
		const files = ws.git(['show', '--name-only', '--pretty=format:', 'HEAD']).split('\n').filter(Boolean).sort();
		assert.deepEqual(files, ['data/analyses/arc.analysis.md', 'data/meetings/one.meeting.md']);
	});
});

// Two ways the rewritten `rm` was found to be wrong. Both were reproduced through the real CLI
// before they were tests; neither is hypothetical.
describe('rm holds at the edges', () => {
	// `recordings` is BOTH sides of a relation at once here — it OWNS an FK to meetings (so removing
	// one detaches a mirror) and is the TARGET of a set-null FK on analyses (so removing one clears
	// an owner's field). One `rm`, three mutations, which is what makes the failure case below worth
	// writing at all: two of the three land before the one that throws.
	const CAP_ANALYSES = simpleCollection({
		storage: { suffix: 'analysis' },
		schema: {
			type: 'object',
			required: ['name'],
			properties: {
				name: { type: 'string' },
				recordings: { type: 'array', 'x-inverse': 'analyses', 'x-on-delete': 'set-null', items: { type: 'string', 'x-reference': 'recordings' } },
			},
		},
	});

	test('a delete that FAILS puts the mirror and the set-null owner back', () => {
		// The delete used to be rm's FIRST mutation, so a failing unlink left the tree untouched. It is
		// now the LAST of three, and outside the rollback it left two other records silently rewritten —
		// a detached mirror and a cleared FK — behind a verb that threw. `check` then reports two stale
		// violations nobody asked for. 0500 on the collection dir is the cheap, portable stand-in for
		// the real cases: a read-only mount, `chflags uchg`, a folder-shape record raced by another
		// writer.
		//
		// In-process through the Store, because half of what has to be restored is IN MEMORY: the id
		// memo is dropped on the way in and repopulated mid-write, and a rollback that leaves it saying
		// the wrong thing is a dangling reference from the NEXT write, not this one.
		const ws = workspace({ collections: { meetings: MEETINGS, recordings: RECORDINGS, analyses: CAP_ANALYSES } });
		ws.store.add('meetings', { name: 'Standup' });
		ws.store.add('recordings', { name: 'Cap', meeting: 'meetings/standup' });
		ws.store.add('recordings', { name: 'Other' });
		ws.store.add('analyses', { name: 'Arc', recordings: ['recordings/cap', 'recordings/other'] });
		const before = {
			meeting: readFile(ws.root, 'data/meetings/standup.meeting.md'),
			analysis: readFile(ws.root, 'data/analyses/arc.analysis.md'),
			recording: readFile(ws.root, 'data/recordings/cap.recording.md'),
		};
		const dir = `${ws.root}/data/recordings`;
		fs.chmodSync(dir, 0o500); // r-x: the file is readable, the directory entry cannot be unlinked
		try {
			assert.throws(() => ws.store.rm('recordings', 'cap'), /EACCES|EPERM/);
		} finally {
			fs.chmodSync(dir, 0o700); // …or the fixture cannot be cleaned up
		}
		assert.equal(readFile(ws.root, 'data/recordings/cap.recording.md'), before.recording);
		assert.equal(readFile(ws.root, 'data/meetings/standup.meeting.md'), before.meeting);
		assert.equal(readFile(ws.root, 'data/analyses/arc.analysis.md'), before.analysis);
		// …and the memo agrees with the disk for every collection the write touched
		assert.equal(ws.store.ids('recordings').has('cap'), true);
		assert.equal(ws.store.ids('meetings').has('standup'), true);
		assert.equal(ws.store.ids('analyses').has('arc'), true);
		assert.deepEqual(ws.store.read('meetings', 'standup').fields.recordings, ['recordings/cap']);
		assert.deepEqual(ws.store.read('analyses', 'arc').fields.recordings, ['recordings/cap', 'recordings/other']);
		const check = ws.dt('check');
		assert.equal(check.code, 0, check.stdout);
	});

	test('a set-null owner that ALSO names this record in prose still refuses', () => {
		// The exclusion is what makes the detach possible, and it was applied to the whole FILE — so a
		// record whose FK is about to be cleared could carry a second, unmanaged reference in its body
		// and have it excluded along with the first. Nothing would ever report it: `check` reads
		// frontmatter, never prose.
		const SN = structuredClone(ANALYSES);
		SN.schema.properties.meetings.items['x-on-delete'] = 'set-null';
		SN.schema.properties.notes = { type: 'string', 'x-body': true };
		const ws = workspace({ collections: { meetings: MEETINGS, analyses: SN } });
		ws.dt('add', 'meetings', '--name', 'One');
		ws.dt('add', 'analyses', '--name', 'Arc', '--meetings', 'meetings/one');
		const f = `${ws.root}/data/analyses/arc.analysis.md`;
		fs.writeFileSync(f, `${fs.readFileSync(f, 'utf8').trimEnd()}\n\nas discussed in [[meetings/one]]\n`);
		const res = ws.dt('rm', 'meetings/one');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /referenced by/);
		assert.match(res.stderr, /data\/analyses\/arc\.analysis\.md/);
		assert.match(readFile(ws.root, 'data/analyses/arc.analysis.md'), /meetings:\n {2}- meetings\/one/);
		const check = ws.dt('check');
		assert.equal(check.code, 0, check.stdout);
	});

	test('a mirror target that ALSO names the owner in prose still refuses', () => {
		// The same narrowing on the other exclusion. One occurrence in that file is the engine's own
		// bookkeeping and is not a reason to refuse; two means one of them is somebody's writing.
		const M = simpleCollection({
			storage: { suffix: 'meeting' },
			schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, notes: { type: 'string', 'x-body': true } } },
		});
		const ws = workspace({ collections: { meetings: M, recordings: RECORDINGS } });
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('add', 'recordings', '--name', 'Cap', '--meeting', 'meetings/standup');
		const f = `${ws.root}/data/meetings/standup.meeting.md`;
		fs.writeFileSync(f, `${fs.readFileSync(f, 'utf8').trimEnd()}\n\nthe good bit is in [[recordings/cap]]\n`);
		const res = ws.dt('rm', 'recordings/cap');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /data\/meetings\/standup\.meeting\.md/);
		assert.match(readFile(ws.root, 'data/meetings/standup.meeting.md'), /recordings:\n {2}- recordings\/cap/);
		const check = ws.dt('check');
		assert.equal(check.code, 0, check.stdout);
	});
});

// A single-target FK is accepted BARE on input and qualified before disk — but only through the
// store's own write path. A hand-authored record, or one written before namespaces, legitimately
// holds `meetings: [one]` where the engine would have written `meetings: [meetings/one]`. The
// exclusion arithmetic has to survive that, because the two numbers it compares are counted from
// different places: one from parsed FIELDS, one from the file's raw BYTES.
describe('the exclusion arithmetic survives a bare foreign key', () => {
	const bareWorkspace = () => {
		const SN = structuredClone(ANALYSES);
		SN.schema.properties.meetings.items['x-on-delete'] = 'set-null';
		SN.schema.properties.notes = { type: 'string', 'x-body': true };
		const ws = workspace({ collections: { meetings: MEETINGS, analyses: SN } });
		ws.dt('add', 'meetings', '--name', 'One');
		ws.dt('add', 'analyses', '--name', 'Arc', '--meetings', 'meetings/one');
		return ws;
	};
	// hand-edit the FK down to the bare id, optionally adding a body that names the record in full
	const unqualify = (ws, body = '') => {
		const f = `${ws.root}/data/analyses/arc.analysis.md`;
		const text = fs.readFileSync(f, 'utf8').replace('- meetings/one', '- one').trimEnd();
		fs.writeFileSync(f, `${text}\n${body}`);
	};

	test('a BARE set-null FK cannot absorb a prose reference in the same record', () => {
		// The two counts were measured in different units. `plan` matched SEMANTICALLY — `isSelf` is
		// deliberately blind to whether a value is qualified — while `occurrences` greps the raw text
		// for the FULLY-QUALIFIED ref, which a bare FK does not contain. So the bare FK claimed a
		// removal that removes no text, and the slack swallowed a real, separate wikilink: rm green,
		// link dangling, `check` silent (it reads frontmatter, never prose).
		const ws = bareWorkspace();
		unqualify(ws, '\nsee [[meetings/one]]\n');
		const res = ws.dt('rm', 'meetings/one');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /referenced by/);
		assert.match(res.stderr, /data\/analyses\/arc\.analysis\.md/);
		const a = readFile(ws.root, 'data/analyses/arc.analysis.md');
		assert.match(a, /- one/); // the bare FK is untouched…
		assert.match(a, /\[\[meetings\/one\]\]/); // …and so is the link that earned the refusal
	});

	test('a BARE set-null FK on its own still clears, without refusing', () => {
		// The other half, and the reason the fix cannot simply be "count bare values as text": a record
		// whose ONLY reference is the bare FK contains no literal `meetings/one` at all, so the scan
		// never names it — and clearing it is exactly what `x-on-delete: set-null` asks for.
		const ws = bareWorkspace();
		unqualify(ws);
		const res = ws.dt('rm', 'meetings/one');
		assert.equal(res.code, 0, res.stderr);
		assert.doesNotMatch(readFile(ws.root, 'data/analyses/arc.analysis.md'), /meetings:/);
		const check = ws.dt('check');
		assert.equal(check.code, 0, check.stdout);
	});
});

describe('rename and relations', () => {
	test('rename rewrites the mirror like any inbound ref', () => {
		// A mirror value is not a special case for `rename`: it is a fully-qualified ref sitting in a
		// record file, so `rewriteRefs` — which walks every record and rewrites the text — already
		// carries it. This test exists to PIN that, because the alternative implementation is tempting:
		// recomputing mirrors from the relation graph on rename would be a second code path maintaining
		// the same values, and it would drift. If this ever goes red the fix belongs in `rewriteRefs`,
		// not in a rename-specific mirror pass.
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('add', 'recordings', '--name', 'Cap', '--meeting', 'meetings/standup');
		assert.equal(ws.dt('rename', 'recordings/cap', 'cap-2').code, 0);
		assert.match(readFile(ws.root, 'data/meetings/standup.meeting.md'), /recordings\/cap-2/);
		assert.equal(ws.dt('check').code, 0);
	});
});
