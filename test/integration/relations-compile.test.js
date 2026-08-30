// Tier 2 — compile is the ONLY producer of the compiled relation shape, and it accepts TWO source
// spellings for the same relation: `x-inverse` on the owning (foreign-key) side, or `x-inverse-of`
// on the side that wants the mirror. Both must land on disk as the SAME bytes, because everything
// downstream (relations.js, check, the store's mirror maintenance) reads the compiled artifact and
// must never learn that two spellings existed.
//
// The load-bearing assertions are therefore (a) the generated mirror's exact shape and (b) the
// byte-for-byte equality of the two spellings — an assertion no unit test can make, because the
// thing being compared is the artifact.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { workspace, simpleCollection, compileError, readFile } from '../helpers/ws.js';
import { load } from '../../src/yaml.js';

// The four-collection cast every case here is cut from: one anchor plus the three cardinalities —
// many-to-one (recordings), one-to-one (summaries, via x-unique) and many-to-many (analyses).
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

const relWorkspace = () => workspace({
	collections: { meetings: MEETINGS, recordings: RECORDINGS, summaries: SUMMARIES, analyses: ANALYSES },
});

describe('compile materializes relations', () => {
	test('spelling A stamps a readOnly mirror on the target', () => {
		const ws = relWorkspace();
		const meetings = load(readFile(ws.root, '.dreamteamer/collections/meetings.collection.yaml'));
		const rec = meetings.schema.properties.recordings;
		assert.equal(rec.type, 'array');
		assert.equal(rec.readOnly, true);
		assert.equal(rec.items['x-reference'], 'recordings');
		assert.equal(rec.items['x-inverse-of'], 'recordings.meeting');
		assert.match(rec.description, /Generated from recordings\.meeting/);
		const sum = meetings.schema.properties.summary;
		assert.equal(sum.type, 'string'); // unique ⇒ scalar mirror
		assert.equal(sum['x-inverse-of'], 'summaries.meeting');
	});

	test('spelling B compiles to the identical pair (spelling equivalence)', () => {
		// same relation declared from the OTHER side: meetings authors the mirror, recordings has a plain ref
		const B_RECORDINGS = structuredClone(RECORDINGS);
		delete B_RECORDINGS.schema.properties.meeting['x-inverse'];
		const B_MEETINGS = simpleCollection({ storage: { suffix: 'meeting' } });
		B_MEETINGS.schema.properties.recordings = {
			type: 'array',
			items: { type: 'string', 'x-reference': 'recordings' },
			'x-inverse-of': 'recordings.meeting',
		};
		const a = relWorkspace();
		const b = workspace({ collections: { meetings: B_MEETINGS, recordings: B_RECORDINGS, summaries: SUMMARIES, analyses: ANALYSES } });
		for (const f of ['meetings', 'recordings']) {
			assert.equal(
				readFile(b.root, `.dreamteamer/collections/${f}.collection.yaml`),
				readFile(a.root, `.dreamteamer/collections/${f}.collection.yaml`),
				`${f}: spelling B must compile byte-identical to spelling A`);
		}
	});

	test('a scalar spelling-B mirror closes cardinality backwards: x-unique lands on the FK', () => {
		const M = simpleCollection({ storage: { suffix: 'meeting' } });
		M.schema.properties.summary = { type: 'string', 'x-inverse-of': 'summaries.meeting' };
		const S = structuredClone(SUMMARIES);
		delete S.schema.properties.meeting['x-unique'];
		delete S.schema.properties.meeting['x-inverse'];
		const ws = workspace({ collections: { meetings: M, summaries: S } });
		const compiled = load(readFile(ws.root, '.dreamteamer/collections/summaries.collection.yaml'));
		assert.equal(compiled.schema.properties.meeting['x-unique'], true);
	});
});

describe('compile refuses a mirror it would generate in a shape nobody can write', () => {
	test('a required field that a relation generates as a readOnly mirror fails compile — both spellings', () => {
		// spelling A: the target never authored the field at all, but names it in `required` — the
		// mirror lands readOnly and every record is then invalid the moment it is written by hand.
		const M = simpleCollection({ storage: { suffix: 'meeting' } });
		M.schema.required = ['name', 'recordings'];
		const a = workspace({ compile: false, collections: { meetings: M, recordings: RECORDINGS } });
		assert.match(compileError(a.ws), /"recordings" is required, but recordings\.meeting generates it/);

		// spelling B reaches the SAME guard: pass 1 deletes the authored field and pass 2 puts the
		// generated one back under the same key, so `required` still names it.
		const B_M = simpleCollection({ storage: { suffix: 'meeting' } });
		B_M.schema.required = ['name', 'recordings'];
		B_M.schema.properties.recordings = {
			type: 'array',
			items: { type: 'string', 'x-reference': 'recordings' },
			'x-inverse-of': 'recordings.meeting',
		};
		const B_R = structuredClone(RECORDINGS);
		delete B_R.schema.properties.meeting['x-inverse'];
		const b = workspace({ compile: false, collections: { meetings: B_M, recordings: B_R } });
		assert.match(compileError(b.ws), /"recordings" is required, but recordings\.meeting generates it/);
	});

	test('a hand-authored mirror keeps description and x-title-template; a shape mismatch is a collision', () => {
		const M = simpleCollection({ storage: { suffix: 'meeting' } });
		M.schema.properties.recordings = {
			type: 'array',
			description: 'The captures of this call.',
			items: { type: 'string', 'x-reference': 'recordings', 'x-title-template': '{{ name }} ({{ id }})' },
			'x-nonsense': 'dropped', // everything except the two carried keywords is discarded
		};
		const ws = workspace({ collections: { meetings: M, recordings: RECORDINGS } });
		const meetings = load(readFile(ws.root, '.dreamteamer/collections/meetings.collection.yaml'));
		const rec = meetings.schema.properties.recordings;
		assert.equal(rec.readOnly, true);
		assert.equal(rec.description, 'The captures of this call.');
		assert.equal(rec.items['x-title-template'], '{{ name }} ({{ id }})');
		assert.equal(rec['x-nonsense'], undefined);

		// an array mirror whose ITEMS are a different type is a real collision, not the tolerated
		// both-sides spelling — the old shape test only compared the outer type and let it through
		const BAD = simpleCollection({ storage: { suffix: 'meeting' } });
		BAD.schema.properties.recordings = {
			type: 'array',
			items: { type: 'object', 'x-reference': 'recordings' },
		};
		const bad = workspace({ compile: false, collections: { meetings: BAD, recordings: RECORDINGS } });
		assert.match(compileError(bad.ws), /collides with the mirror generated from recordings\.meeting/);
	});
});

describe('compile refuses malformed relations', () => {
	test("x-inverse on '*' is an error", () => {
		const BAD = simpleCollection({ storage: { suffix: 'note' } });
		BAD.schema.properties.about = { type: 'string', 'x-reference': '*', 'x-inverse': 'notes' };
		const err = compileError(workspace({ collections: { notes: BAD }, compile: false }).ws);
		assert.match(err, /x-inverse on x-reference '\*'/);
	});
	test('both sides disagreeing is an error', () => {
		const M = simpleCollection({ storage: { suffix: 'meeting' } });
		M.schema.properties.captures = { type: 'array', items: { type: 'string', 'x-reference': 'recordings' }, 'x-inverse-of': 'recordings.meeting' };
		const err = compileError(workspace({ collections: { meetings: M, recordings: RECORDINGS }, compile: false }).ws);
		assert.match(err, /declared on both sides and they disagree/);
	});
	test('set-null on a required FK is an error', () => {
		const R = structuredClone(RECORDINGS);
		R.schema.required = ['name', 'meeting'];
		R.schema.properties.meeting['x-on-delete'] = 'set-null';
		const err = compileError(workspace({ collections: { meetings: MEETINGS, recordings: R }, compile: false }).ws);
		assert.match(err, /set-null would produce an invalid record/);
	});
	test('array mirror of a unique FK is a cardinality error', () => {
		const M = simpleCollection({ storage: { suffix: 'meeting' } });
		M.schema.properties.summaries = { type: 'array', items: { type: 'string', 'x-reference': 'summaries' }, 'x-inverse-of': 'summaries.meeting' };
		const S = structuredClone(SUMMARIES); delete S.schema.properties.meeting['x-inverse'];
		const err = compileError(workspace({ collections: { meetings: M, summaries: S }, compile: false }).ws);
		assert.match(err, /array mirror of the unique FK/);
	});
	test('the legacy both-sides shape compiles with a warning', () => {
		const M = structuredClone(MEETINGS);
		M.schema.properties.recordings = { type: 'array', items: { type: 'string', 'x-reference': 'recordings' } };
		const ws = workspace({ collections: { meetings: M, recordings: RECORDINGS } });
		assert.ok(ws.out.warnings.some((w) => w.includes('hand-authored but recordings.meeting declares it')));
	});
	test('self-reference works with a distinct mirror name', () => {
		const C = simpleCollection({ storage: { suffix: 'company' } });
		C.schema.properties.parent = { type: 'string', 'x-reference': 'companies', 'x-inverse': 'subsidiaries' };
		const ws = workspace({ collections: { companies: C } });
		const compiled = load(readFile(ws.root, '.dreamteamer/collections/companies.collection.yaml'));
		assert.equal(compiled.schema.properties.subsidiaries.items['x-inverse-of'], 'companies.parent');
	});
	test('two relations generating ONE mirror name on one target is an error', () => {
		// The unfixable case: both mirrors are arrays of x-reference transactions, so the shape
		// collision guard passes them, and check then computes two contradictory expectations for
		// claims.transactions that no value can satisfy and no rebuild can repair.
		const T = simpleCollection({ storage: { suffix: 'txn' } });
		T.schema.properties.claim = { type: 'string', 'x-reference': 'claims', 'x-inverse': 'transactions' };
		T.schema.properties.reimburses_claim = { type: 'string', 'x-reference': 'claims', 'x-inverse': 'transactions' };
		const err = compileError(workspace({ compile: false, collections: { claims: simpleCollection({ storage: { suffix: 'claim' } }), transactions: T } }).ws);
		assert.match(err, /both transactions\.claim and transactions\.reimburses_claim generate a mirror named "transactions"/);
	});

	test('double reference into one target works with distinct mirror names', () => {
		const T = simpleCollection({ storage: { suffix: 'txn' } });
		T.schema.properties.claim = { type: 'string', 'x-reference': 'claims', 'x-inverse': 'expense_transactions' };
		T.schema.properties.reimburses_claim = { type: 'string', 'x-reference': 'claims', 'x-inverse': 'reimbursement_transactions' };
		const ws = workspace({ collections: { claims: simpleCollection({ storage: { suffix: 'claim' } }), transactions: T } });
		const claims = load(readFile(ws.root, '.dreamteamer/collections/claims.collection.yaml'));
		assert.ok(claims.schema.properties.expense_transactions && claims.schema.properties.reimbursement_transactions);
	});
});


// ---- check, against the same cast ------------------------------------------------------------
// A mirror is DERIVED state: the owning side's FK is the truth, and the mirror is a cache of it.
// So check never asks "do both sides agree" — it recomputes what the owners imply and compares.
// (The store does not maintain mirrors yet, which is exactly why the first case below is a real
// reading and not a contrivance: a one-sided write leaves the mirror behind, and check says so.)
describe('check verifies mirrors', () => {
	test('a mirror the owning side has outgrown is flagged with the rebuild hint', () => {
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('add', 'recordings', '--name', 'Cap1', '--meeting', 'meetings/standup');
		// the recording claims the meeting; the meeting carries no `recordings` at all
		const res = ws.dt('check');
		assert.equal(res.code, 1);
		assert.match(res.stdout, /recordings: stale — run: dreamteamer relations rebuild meetings/);
	});

	test('a hand-edited mirror pointing somewhere else is stale, not merely dangling', () => {
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('add', 'recordings', '--name', 'Cap1', '--meeting', 'meetings/standup');
		// vandalize the mirror by hand — a value that resolves to nothing AND disagrees with the owner
		const f = `${ws.root}/data/meetings/standup.meeting.md`;
		fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^---\n/, '---\nrecordings:\n  - recordings/ghost\n'));
		const res = ws.dt('check');
		assert.equal(res.code, 1);
		// `recordings/ghost` is also a dangling reference; the staleness finding is the one under test
		assert.match(res.stdout, /recordings: stale — run: dreamteamer relations rebuild meetings/);
	});

	test('a mirror that matches the owning side is silent', () => {
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('add', 'recordings', '--name', 'Cap1', '--meeting', 'meetings/standup');
		const f = `${ws.root}/data/meetings/standup.meeting.md`;
		fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^---\n/, '---\nrecordings:\n  - recordings/cap1\n'));
		const res = ws.dt('check');
		assert.equal(res.code, 0, res.stdout + res.stderr);
	});

	test('x-unique refuses two summaries for one meeting', () => {
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		assert.equal(ws.dt('add', 'summaries', '--name', 'One', '--meeting', 'meetings/standup').code, 0);
		// bypass the store to plant the duplicate, then check must catch it
		fs.writeFileSync(`${ws.root}/data/summaries/two.summary.md`, '---\nname: Two\nmeeting: meetings/standup\n---\n');
		const res = ws.dt('check');
		assert.equal(res.code, 1);
		assert.match(res.stdout, /meeting: "meetings\/standup" is already taken by summaries\/one \(x-unique\)/);
	});
});
