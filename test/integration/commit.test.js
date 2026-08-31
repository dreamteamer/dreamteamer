// Tier 2 — `dt commit`, and specifically WHAT it is allowed to sweep up.
//
// The defect this file exists for: commit samples `git status` over a collection's record
// directories, so `dt commit <collection>` published every dirty record under them REGARDLESS OF
// WHO WROTE IT. Two agents on one workspace, and one session's commit swallows the other's pending
// records — invisibly, because `git status` is clean afterwards.
//
// The fix widens the TARGET (a record reference is now accepted) and deliberately leaves the
// SAMPLER alone: sampling from `git status` is what makes a hand-edited markdown body
// indistinguishable from a record the store wrote, which is the property `dt commit` is for. So the
// load-bearing assertion in here is always the NEGATIVE one — the sibling record is still dirty.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { workspace, simpleCollection } from '../helpers/ws.js';

const CONTACTS = {
	id: { generate: '{{ name | slug }}' },
	storage: { suffix: 'contact' },
	schema: {
		type: 'object',
		required: ['name'],
		properties: { name: { type: 'string' }, email: { type: 'string' } },
	},
};

// A namespaced collection with a path-shaped id: `finance/transactions/2026/03/coffee` is the
// reference no first-slash split can read, and the reason commit must go through splitRef.
const TRANSACTIONS = {
	id: { generate: '{{ month }}/{{ label | slug }}' },
	storage: { suffix: 'txn' },
	schema: {
		type: 'object',
		required: ['label', 'month'],
		properties: { label: { type: 'string' }, month: { type: 'string' } },
	},
};

/** A workspace with two contacts, two transactions and two widgets — all written, none committed. */
function seeded() {
	const ws = workspace({
		namespaces: ['finance'],
		collections: {
			contacts: CONTACTS,
			'finance/transactions': TRANSACTIONS,
			widgets: simpleCollection({ storage: { suffix: 'widget' } }),
		},
	});
	assert.equal(ws.dt('add', 'contacts', '--name', 'Jane').code, 0);
	assert.equal(ws.dt('add', 'contacts', '--name', 'John').code, 0);
	assert.equal(ws.dt('add', 'finance/transactions', '--label', 'Coffee', '--month', '2026/03').code, 0);
	assert.equal(ws.dt('add', 'finance/transactions', '--label', 'Rent', '--month', '2026/03').code, 0);
	assert.equal(ws.dt('add', 'widgets', '--name', 'Alpha').code, 0);
	return ws;
}

/** What `dt commit --dry-run --json` still sees as pending, as `<collection>/<id>` strings. */
function pending(ws) {
	const res = ws.dt('commit', '--dry-run', '--json');
	assert.equal(res.code, 0, res.stderr);
	return JSON.parse(res.stdout).flatMap((r) => r.rows.map((row) => `${row.collection}/${row.id}`)).sort();
}

/** git's own answer, so the assertion does not depend on the code under test. */
function dirty(ws, rel) {
	return ws.git(['status', '--porcelain', '-uall', '--', rel]).length > 0;
}

describe('dt commit <collection>/<id> — one record, by reference', () => {
	// THE test. Everything else in this file is a variation on it.
	test('commits exactly that record and leaves its sibling pending', () => {
		const ws = seeded();
		const res = ws.dt('commit', 'contacts/jane');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /add contacts\/jane/);
		assert.doesNotMatch(res.stdout, /contacts\/john/);

		assert.equal(dirty(ws, 'data/contacts/jane.contact.md'), false, 'jane must be committed');
		assert.equal(dirty(ws, 'data/contacts/john.contact.md'), true, 'john must STILL BE PENDING');
		assert.deepEqual(pending(ws), [
			'contacts/john',
			'finance/transactions/2026/03/coffee',
			'finance/transactions/2026/03/rent',
			'widgets/alpha',
		]);
	});

	test('the subject is the single-record one, naming that record', () => {
		const ws = seeded();
		assert.equal(ws.dt('commit', 'contacts/jane').code, 0);
		assert.equal(ws.git(['log', '-1', '--pretty=%s']), 'dreamteamer: contacts add jane');
	});

	test('a namespaced collection with a path-shaped id resolves as one reference', () => {
		const ws = seeded();
		const res = ws.dt('commit', 'finance/transactions/2026/03/coffee');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /finance\/transactions\/2026\/03\/coffee/);
		assert.equal(dirty(ws, 'data/finance/transactions/2026/03/coffee.txn.md'), false);
		assert.equal(dirty(ws, 'data/finance/transactions/2026/03/rent.txn.md'), true, 'rent must stay pending');
	});

	test('a reference and a bare collection mix in one invocation', () => {
		const ws = seeded();
		const res = ws.dt('commit', 'contacts/jane', 'finance/transactions');
		assert.equal(res.code, 0, res.stderr);
		assert.deepEqual(pending(ws), ['contacts/john', 'widgets/alpha']);
	});

	test('-m overrides the subject for a reference target', () => {
		const ws = seeded();
		assert.equal(ws.dt('commit', 'contacts/jane', '-m', 'hand-written subject').code, 0);
		assert.equal(ws.git(['log', '-1', '--pretty=%s']), 'hand-written subject');
	});

	test('--dry-run with a reference reports the one row and commits nothing', () => {
		const ws = seeded();
		const head = ws.git(['rev-parse', 'HEAD']);
		const res = ws.dt('commit', 'contacts/jane', '--dry-run', '--json');
		assert.equal(res.code, 0, res.stderr);
		const rows = JSON.parse(res.stdout).flatMap((r) => r.rows);
		assert.deepEqual(rows.map((r) => `${r.collection}/${r.id}`), ['contacts/jane']);
		assert.equal(ws.git(['rev-parse', 'HEAD']), head, 'HEAD must not move');
		assert.equal(dirty(ws, 'data/contacts/jane.contact.md'), true, 'jane must still be pending');
	});

	test('a reference to a record that is not pending commits nothing, loudly enough', () => {
		const ws = seeded();
		assert.equal(ws.dt('commit', 'contacts/jane').code, 0);
		const again = ws.dt('commit', 'contacts/jane');
		assert.equal(again.code, 0, again.stderr);
		assert.match(again.stdout, /nothing pending/);
		assert.equal(dirty(ws, 'data/contacts/john.contact.md'), true, 'john is still nobody else\'s business');
	});

	test('an unknown collection in a target fails loudly and commits nothing', () => {
		const ws = seeded();
		const head = ws.git(['rev-parse', 'HEAD']);
		const res = ws.dt('commit', 'nope/x');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /unknown collection in reference "nope\/x"/);
		assert.equal(ws.git(['rev-parse', 'HEAD']), head, 'a bad target must not commit anything');
		assert.equal(pending(ws).length, 5);
	});

	test('an unknown id under a known collection is refused, not silently ignored', () => {
		const ws = seeded();
		const res = ws.dt('commit', 'contacts/nobody');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /contacts\/nobody/);
		assert.equal(pending(ws).length, 5, 'nothing may be committed on a bad target');
	});
});

describe('the older target shapes are unchanged', () => {
	test('dt commit <collection> still publishes the whole collection', () => {
		const ws = seeded();
		const res = ws.dt('commit', 'contacts');
		assert.equal(res.code, 0, res.stderr);
		assert.deepEqual(pending(ws), [
			'finance/transactions/2026/03/coffee',
			'finance/transactions/2026/03/rent',
			'widgets/alpha',
		]);
		assert.equal(ws.git(['log', '-1', '--pretty=%s']), 'dreamteamer: contacts 2 changes (2 add)');
	});

	test('bare dt commit still publishes everything pending', () => {
		const ws = seeded();
		const res = ws.dt('commit');
		assert.equal(res.code, 0, res.stderr);
		assert.deepEqual(pending(ws), []);
		// only `data/` — the fixture's own uncommitted SOURCES are not commit's business, and
		// asserting on the whole tree would assert that they are.
		assert.equal(ws.git(['status', '--porcelain', '-uall', '--', 'data']), '');
	});

	test('two bare collections still scope to both', () => {
		const ws = seeded();
		assert.equal(ws.dt('commit', 'contacts', 'widgets').code, 0);
		assert.deepEqual(pending(ws), [
			'finance/transactions/2026/03/coffee',
			'finance/transactions/2026/03/rent',
		]);
	});
});

describe('a hand-edited record is still publishable — the sampler is untouched', () => {
	test('a body edited outside the store commits by reference', () => {
		const ws = seeded();
		assert.equal(ws.dt('commit').code, 0);
		const rel = 'data/contacts/jane.contact.md';
		fs.appendFileSync(`${ws.root}/${rel}`, '\nhand-written prose.\n');
		const res = ws.dt('commit', 'contacts/jane');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /set contacts\/jane/);
		assert.equal(dirty(ws, rel), false);
	});
});

// A relational write dirties TWO records — the owner's foreign key and the target's mirror. With
// auto-commit off (the default since 2026-08-03) a record-scoped publish would commit the owner and
// leave the mirror pending, so HEAD carries half a pair and `dt check` at HEAD is red. The pair is
// the unit; the bystander is still not.
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

describe('commit sweeps a record’s relation partners', () => {
	test('committing the owner also publishes the dirty mirror, and nothing else', () => {
		const ws = workspace({ collections: { meetings: MEETINGS, recordings: RECORDINGS, widgets: simpleCollection({ storage: { suffix: 'widget' } }) } });
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('add', 'widgets', '--name', 'Alpha');
		ws.dt('add', 'recordings', '--name', 'Cap', '--meeting', 'meetings/standup');
		const res = ws.dt('commit', 'recordings/cap');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /recordings\/cap/);
		assert.match(res.stdout, /meetings\/standup/); // the mirror file came along
		const still = ws.dt('commit', '--dry-run', '--json');
		assert.match(still.stdout, /widgets\/alpha/); // the bystander is still pending
	});

	test('an unrelated record in the PARTNER collection stays pending', () => {
		// The load-bearing negative one. Widening the scope to the partner collection is what lets the
		// sampler see the mirror at all — so the partner collection is now full of rows this commit
		// must NOT touch. A second meeting, written by another session, is exactly that.
		const ws = workspace({ collections: { meetings: MEETINGS, recordings: RECORDINGS } });
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('add', 'meetings', '--name', 'Retro');
		ws.dt('add', 'recordings', '--name', 'Cap', '--meeting', 'meetings/standup');
		assert.equal(ws.dt('commit', 'recordings/cap').code, 0);
		assert.deepEqual(pending(ws), ['meetings/retro']);
	});

	test('committing a deletion sweeps the detached mirror', () => {
		// The deletion case cannot be answered from the store: the named record is GONE, so there is
		// nothing left to read its foreign key from. The partner is found from the other end instead —
		// the mirror the store just detached is itself a dirty row.
		const ws = workspace({ collections: { meetings: MEETINGS, recordings: RECORDINGS } });
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('add', 'recordings', '--name', 'Cap', '--meeting', 'meetings/standup');
		ws.dt('commit');
		ws.dt('rm', 'recordings/cap');
		const res = ws.dt('commit', 'recordings/cap');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /meetings\/standup/);
	});
});

// ── the sweep is NARROW: only an edge that actually CHANGED pulls a partner in ──────────────────
//
// The first cut swept every ref in the named record's relation fields, which reintroduced the exact
// damage this file exists to prevent: a partner dirty for some unrelated reason — another session's
// prose, another session's relational write to the same target — was published under this commit's
// subject, `git status` clean afterwards so the theft was invisible (CLAUDE.md rule 6, three times).
describe('the sweep follows the edge, not the field', () => {
	/** Standup + Cap, related and published. HEAD is consistent; every test below diverges from it. */
	function pair() {
		const ws = workspace({ collections: { meetings: MEETINGS, recordings: RECORDINGS } });
		assert.equal(ws.dt('add', 'meetings', '--name', 'Standup').code, 0);
		assert.equal(ws.dt('add', 'recordings', '--name', 'Cap', '--meeting', 'meetings/standup').code, 0);
		assert.equal(ws.dt('commit').code, 0);
		return ws;
	}

	test('a partner dirty for PROSE ONLY is left alone', () => {
		// C1. Session B is writing a paragraph into the meeting; session A renames the recording. The
		// edge between them did not move, so A's commit has no business touching B's file.
		const ws = pair();
		fs.appendFileSync(`${ws.root}/data/meetings/standup.meeting.md`, '\nsession B was here.\n');
		assert.equal(ws.dt('set', 'recordings/cap', 'name=Cap v2').code, 0);
		const res = ws.dt('commit', 'recordings/cap');
		assert.equal(res.code, 0, res.stderr);
		assert.deepEqual(pending(ws), ['meetings/standup'], 'B\'s paragraph must STILL BE PENDING');
	});

	test('clearing the foreign key still sweeps — that edge did change', () => {
		const ws = pair();
		assert.equal(ws.dt('set', 'recordings/cap', 'meeting=').code, 0);
		const res = ws.dt('commit', 'recordings/cap');
		assert.equal(res.code, 0, res.stderr);
		assert.deepEqual(pending(ws), []);
	});

	test('a rename publishes BOTH halves, old path and new', () => {
		// `dt rename` leaves the old path deleted and the new path untracked — neither staged, so git
		// reports no `R` and the two halves look like unrelated records. Publish one and HEAD holds
		// both files, with the mirror naming only one of them: check goes red.
		const ws = pair();
		assert.equal(ws.dt('rename', 'recordings/cap', 'cap-2').code, 0);
		const res = ws.dt('commit', 'recordings/cap-2');
		assert.equal(res.code, 0, res.stderr);
		assert.equal(ws.git(['status', '--porcelain', '-uall', '--', 'data']), '', 'no half-rename may be left behind');
		assert.equal(ws.dt('check').code, 0);
	});

	test('an unparseable pre-image on the SWEPT PARTNER is survivable too', () => {
		// The reviewer's repro, and the worse half: the broken pre-image is not the record you named,
		// so the bare YAML error names no file at all — and `dt commit <collection>` and bare
		// `dt commit` both keep working, which sends the reader looking at the reference parser.
		const ws = pair();
		const f = `${ws.root}/data/meetings/standup.meeting.md`;
		const good = fs.readFileSync(f, 'utf8');
		fs.writeFileSync(f, '---\nname: [unclosed\nrecordings:\n  - recordings/cap\n---\n');
		assert.equal(ws.dt('commit', 'meetings/standup').code, 0); // HEAD now holds the broken one
		fs.writeFileSync(f, good);
		assert.equal(ws.dt('set', 'recordings/cap', 'meeting=').code, 0);
		const res = ws.dt('commit', 'recordings/cap');
		assert.equal(res.code, 0, res.stderr);
	});

	test('an unparseable pre-image is "no known edges", not a crash', () => {
		// A record hand-edited into broken frontmatter and published weeks ago must not take the verb
		// down — and if it does, it does so ONLY for the record-scoped form, which is the shape of bug
		// nobody attributes correctly.
		const ws = pair();
		const f = `${ws.root}/data/recordings/cap.recording.md`;
		fs.writeFileSync(f, '---\nname: [unclosed\nmeeting: meetings/standup\n---\n\nbody\n');
		assert.equal(ws.dt('commit', 'recordings/cap').code, 0);
		fs.appendFileSync(f, 'more prose\n');
		const res = ws.dt('commit', 'recordings/cap');
		assert.equal(res.code, 0, res.stderr);
	});
});

describe('two sessions writing edges into ONE partner file', () => {
	// A mirror file records the edges of EVERY owner pointing at it. Committing that file publishes
	// all of its edge changes at once — so when two sessions have each attached an owner since HEAD,
	// there is no commit that publishes one without the other. Refusing is the only honest answer:
	// the alternatives are stealing a record or knowingly publishing a red HEAD.
	function standup() {
		const ws = workspace({ collections: { meetings: MEETINGS, recordings: RECORDINGS } });
		assert.equal(ws.dt('add', 'meetings', '--name', 'Standup').code, 0);
		assert.equal(ws.dt('commit').code, 0);
		return ws;
	}

	test('naming the TARGET refuses when two owners attached since HEAD', () => {
		const ws = standup();
		assert.equal(ws.dt('add', 'recordings', '--name', 'A', '--meeting', 'meetings/standup').code, 0);
		assert.equal(ws.dt('add', 'recordings', '--name', 'B', '--meeting', 'meetings/standup').code, 0);
		const res = ws.dt('commit', 'meetings/standup');
		assert.equal(res.code, 1, res.stdout);
		assert.match(res.stderr, /data\/meetings\/standup\.meeting\.md/);
		assert.match(res.stderr, /recordings\/a/);
		assert.match(res.stderr, /recordings\/b/);
		assert.match(res.stderr, /dreamteamer commit/);
		assert.equal(pending(ws).length, 3, 'a refusal must commit nothing');
	});

	test('naming ONE owner refuses too, naming the other session\'s record', () => {
		const ws = standup();
		assert.equal(ws.dt('add', 'recordings', '--name', 'A', '--meeting', 'meetings/standup').code, 0);
		assert.equal(ws.dt('add', 'recordings', '--name', 'B', '--meeting', 'meetings/standup').code, 0);
		const res = ws.dt('commit', 'recordings/a');
		assert.equal(res.code, 1, res.stdout);
		assert.match(res.stderr, /recordings\/b/);
		assert.equal(pending(ws).length, 3);
	});

	test('naming both together is what the refusal asks for, and it works', () => {
		const ws = standup();
		assert.equal(ws.dt('add', 'recordings', '--name', 'A', '--meeting', 'meetings/standup').code, 0);
		assert.equal(ws.dt('add', 'recordings', '--name', 'B', '--meeting', 'meetings/standup').code, 0);
		const res = ws.dt('commit', 'recordings/a', 'recordings/b');
		assert.equal(res.code, 0, res.stderr);
		assert.deepEqual(pending(ws), []);
	});

	test('an owner whose edge is already at HEAD is not one of the parties', () => {
		// Only edges that MOVED since HEAD count, and this pins the negative half of that: A owns its
		// edge from a previous commit, so however the refusal comes out, A is not in it. (Before the
		// entanglement check reached the named record this asserted a green sweep of B — see the test
		// below for why that was C1's theft with the sides swapped.)
		const ws = standup();
		assert.equal(ws.dt('add', 'recordings', '--name', 'A', '--meeting', 'meetings/standup').code, 0);
		assert.equal(ws.dt('commit').code, 0);
		assert.equal(ws.dt('add', 'recordings', '--name', 'B', '--meeting', 'meetings/standup').code, 0);
		const res = ws.dt('commit', 'meetings/standup');
		assert.equal(res.code, 1, res.stdout);
		assert.match(res.stderr, /recordings\/b/);
		assert.doesNotMatch(res.stderr, /recordings\/a/, 'A\'s edge did not move — A is not a party');
	});

	test('naming the TARGET refuses when the ONLY edge change is another session\'s', () => {
		// The residual, and it is C1's theft with the sides swapped. Session B attaches a recording —
		// the store writes B's edge into the MEETING's mirror. Session A never touches an edge at all;
		// it edits a plain field on the meeting and publishes it. A mirror is engine-owned state that
		// another session can write into, so publishing A's own file uninspected hands B's record over
		// under A's subject. The entanglement check therefore covers the NAMED record too, not just
		// the partners it drags in.
		const ws = standup();
		assert.equal(ws.dt('add', 'recordings', '--name', 'Bnew', '--meeting', 'meetings/standup').code, 0);
		assert.equal(ws.dt('set', 'meetings/standup', 'name=Standup, renamed').code, 0);
		const res = ws.dt('commit', 'meetings/standup');
		assert.equal(res.code, 1, res.stdout);
		assert.match(res.stderr, /data\/meetings\/standup\.meeting\.md/);
		assert.match(res.stderr, /recordings\/bnew/);
		assert.match(res.stderr, /dreamteamer commit meetings\/standup recordings\/bnew/);
		assert.equal(pending(ws).length, 2, 'a refusal must commit nothing');
	});

	test('a WHOLE-COLLECTION target counts as named — its rows are not strangers', () => {
		// The caller asked for every recording AND the meeting. The two owners are inside a collection
		// this commit publishes anyway, so there is no other session to protect and nothing to refuse
		// — refusing here would refuse a commit whose every row was explicitly requested.
		const ws = standup();
		assert.equal(ws.dt('add', 'recordings', '--name', 'A', '--meeting', 'meetings/standup').code, 0);
		assert.equal(ws.dt('add', 'recordings', '--name', 'B', '--meeting', 'meetings/standup').code, 0);
		const before = ws.git(['rev-list', '--count', 'HEAD']);
		const res = ws.dt('commit', 'recordings', 'meetings/standup');
		assert.equal(res.code, 0, res.stderr);
		assert.deepEqual(pending(ws), []);
		assert.equal(Number(ws.git(['rev-list', '--count', 'HEAD'])), Number(before) + 1, 'one commit, not two');
	});
});

// ── the scope has to reach TWO hops, or the refusal above cannot fire ───────────────────────────
//
// C1. The stranger test is `rows.has(v)` — a row exists only for a SAMPLED collection. Naming a
// record put its own collection and its partners' in scope, and stopped there: the collection on
// the far side of a partner's OTHER edge was never sampled, so a concurrent session's record there
// was invisible and the commit published the partner carrying a reference to it. HEAD then holds a
// dangling reference and a stale mirror — `dt check` red, on a verb whose whole job is to refuse
// exactly this.
const SUMMARIES = simpleCollection({
	storage: { suffix: 'summary' },
	schema: {
		type: 'object',
		required: ['name'],
		properties: {
			name: { type: 'string' },
			meeting: { type: 'string', 'x-reference': 'meetings', 'x-inverse': 'summary', 'x-unique': true },
		},
	},
});

describe('a stranger on the far side of the swept partner', () => {
	/** Standup + Cap published and UNLINKED — every test below forms the edge itself. */
	function trio() {
		const ws = workspace({ collections: { meetings: MEETINGS, recordings: RECORDINGS, summaries: SUMMARIES } });
		assert.equal(ws.dt('add', 'meetings', '--name', 'Standup').code, 0);
		assert.equal(ws.dt('add', 'recordings', '--name', 'Cap').code, 0);
		assert.equal(ws.dt('commit').code, 0);
		return ws;
	}

	test('refuses: A links the recording, B summarises the same meeting', () => {
		const ws = trio();
		assert.equal(ws.dt('set', 'recordings/cap', 'meeting=meetings/standup').code, 0); // session A
		assert.equal(ws.dt('add', 'summaries', '--name', 'S2', '--meeting', 'meetings/standup').code, 0); // session B
		const res = ws.dt('commit', 'recordings/cap');
		assert.equal(res.code, 1, res.stdout);
		assert.match(res.stderr, /data\/meetings\/standup\.meeting\.md/);
		assert.match(res.stderr, /summaries\/s2/);
		assert.equal(pending(ws).length, 3, 'a refusal must commit nothing');
	});

	test('and naming all three together is what the refusal asks for', () => {
		const ws = trio();
		assert.equal(ws.dt('set', 'recordings/cap', 'meeting=meetings/standup').code, 0);
		assert.equal(ws.dt('add', 'summaries', '--name', 'S2', '--meeting', 'meetings/standup').code, 0);
		const res = ws.dt('commit', 'recordings/cap', 'summaries/s2');
		assert.equal(res.code, 0, res.stderr);
		assert.deepEqual(pending(ws), []);
		assert.equal(ws.dt('check').code, 0);
	});

	test('a two-hop collection with nothing dirty in it does not refuse', () => {
		// The negative half: widening the sample must not turn an ordinary publish into a refusal.
		const ws = trio();
		assert.equal(ws.dt('set', 'recordings/cap', 'meeting=meetings/standup').code, 0);
		const res = ws.dt('commit', 'recordings/cap');
		assert.equal(res.code, 0, res.stderr);
		assert.deepEqual(pending(ws), []);
	});
});

// ── `dt commit <collection>` still publishes half a pair — say so ──────────────────────────────
//
// I3. The whole-collection form deliberately publishes exactly that collection: narrowing it to
// pairs would silently drop rows the caller asked for. So it keeps publishing half a pair, and
// tells the caller which records finish it.
describe('the whole-collection form warns about the partner it leaves behind', () => {
	test('naming the owner collection names the mirror left pending', () => {
		const ws = workspace({ collections: { meetings: MEETINGS, recordings: RECORDINGS } });
		assert.equal(ws.dt('add', 'meetings', '--name', 'Standup').code, 0);
		assert.equal(ws.dt('add', 'recordings', '--name', 'Cap', '--meeting', 'meetings/standup').code, 0);
		const res = ws.dt('commit', 'recordings');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stderr, /meetings\/standup/);
		assert.match(res.stderr, /dreamteamer commit meetings\/standup/);
		assert.deepEqual(pending(ws), ['meetings/standup']);
	});

	test('nothing to say when the pair is published whole', () => {
		const ws = workspace({ collections: { meetings: MEETINGS, recordings: RECORDINGS } });
		assert.equal(ws.dt('add', 'meetings', '--name', 'Standup').code, 0);
		assert.equal(ws.dt('add', 'recordings', '--name', 'Cap', '--meeting', 'meetings/standup').code, 0);
		const res = ws.dt('commit', 'recordings', 'meetings');
		assert.equal(res.code, 0, res.stderr);
		assert.doesNotMatch(res.stderr, /left pending/);
	});

	test('a bystander dirty for its own reasons is not a partner', () => {
		const ws = workspace({ collections: { meetings: MEETINGS, recordings: RECORDINGS } });
		assert.equal(ws.dt('add', 'meetings', '--name', 'Standup').code, 0);
		assert.equal(ws.dt('add', 'meetings', '--name', 'Retro').code, 0);
		assert.equal(ws.dt('add', 'recordings', '--name', 'Cap', '--meeting', 'meetings/standup').code, 0);
		const res = ws.dt('commit', 'recordings');
		assert.equal(res.code, 0, res.stderr);
		assert.doesNotMatch(res.stderr, /meetings\/retro/);
	});

	test('naming the TARGET collection names the OWNER left pending', () => {
		// The other direction, and it has to be read off the owner's own file: `dt commit meetings`
		// publishes the mirror and leaves the foreign key behind, which is the same half-pair with the
		// two collections swapped. A version of this that follows the edge from the published side gets
		// one direction right and the other silently empty.
		const ws = workspace({ collections: { meetings: MEETINGS, recordings: RECORDINGS } });
		assert.equal(ws.dt('add', 'meetings', '--name', 'Standup').code, 0);
		assert.equal(ws.dt('add', 'recordings', '--name', 'Cap', '--meeting', 'meetings/standup').code, 0);
		const res = ws.dt('commit', 'meetings');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stderr, /recordings\/cap/);
		assert.match(res.stderr, /dreamteamer commit recordings\/cap/);
		assert.deepEqual(pending(ws), ['recordings/cap']);
	});

	/** Standup + Cap, related and published, then Cap dirtied for a reason that is NOT its edge. */
	function publishedPair() {
		const ws = workspace({ collections: { meetings: MEETINGS, recordings: RECORDINGS } });
		assert.equal(ws.dt('add', 'meetings', '--name', 'Standup').code, 0);
		assert.equal(ws.dt('add', 'recordings', '--name', 'Cap', '--meeting', 'meetings/standup').code, 0);
		assert.equal(ws.dt('commit').code, 0);
		assert.equal(ws.dt('set', 'recordings/cap', 'name=Cap v2').code, 0);
		return ws;
	}

	/** Hand-edit the whole `recordings:` mirror block out of a meeting file — an edge moving on ONE
	 *  side, which the store itself would never produce and a person does every time they edit a
	 *  record in an editor. */
	function unmirror(ws, id) {
		const f = `${ws.root}/data/meetings/${id}.meeting.md`;
		fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/\nrecordings:\n(  - [^\n]*\n)+/, '\n'));
	}

	test('an edge that moved on ONE SIDE ONLY is still named', () => {
		// ⚠ THE REGRESSION GUARD for the obvious O(published) rewrite of this warning. Session B edits
		// the mirror out of the meeting by hand; the recording's own foreign key never moved. Ask the
		// PUBLISHED recording "did any of your edges move" and the answer is no, so following the edge
		// from that end names nothing at all — while the meeting is a genuine half-pair, and HEAD after
		// this commit is exactly the red `dt check` the warning exists to pre-empt. `moved` compares a
		// row's own file either side of HEAD, so the question can only be asked of the row it is about.
		const ws = publishedPair();
		unmirror(ws, 'standup');
		const res = ws.dt('commit', 'recordings');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stderr, /meetings\/standup/);
		assert.deepEqual(pending(ws), ['meetings/standup']);
	});

	test('one leftover among many dirty partners — and only that one', () => {
		// The pre-images arrive from ONE `git cat-file --batch` now, framed by the byte count git states
		// and paired with the request list BY ORDER. An off-by-one there names the wrong record, and a
		// fixture with one dirty partner could never show it — so this one has twelve, with bodies of
		// deliberately different lengths and the real leftover in the middle. The other eleven are the
		// negative half: dirty for prose, which is nobody's edge changing.
		const ws = workspace({ collections: { meetings: MEETINGS, recordings: RECORDINGS } });
		for (let i = 0; i < 12; i++) {
			assert.equal(ws.dt('add', 'meetings', '--name', `M${i}`, '--notes', 'x'.repeat(i * 40 + 1)).code, 0);
		}
		assert.equal(ws.dt('add', 'recordings', '--name', 'Cap', '--meeting', 'meetings/m6').code, 0);
		assert.equal(ws.dt('commit').code, 0);
		assert.equal(ws.dt('set', 'recordings/cap', 'name=Cap v2').code, 0);
		for (let i = 0; i < 12; i++) fs.appendFileSync(`${ws.root}/data/meetings/m${i}.meeting.md`, '\nsession B was here.\n');
		unmirror(ws, 'm6');
		const res = ws.dt('commit', 'recordings');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stderr, /1 relation partner\(s\) left pending/);
		assert.match(res.stderr, /dreamteamer commit meetings\/m6$/m);
	});
});
