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
