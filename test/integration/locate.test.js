// Tier 2 — `dt locate`: paths in, `<collection>/<id>` refs out.
//
// The verb exists to close a parity gap: pathToRecord served commit/changes internals and the
// extension's fileToRecord, but no CLI — a grep hit or a `git status` path had no headless way back
// to the record it names. The cases below are the ones the mapping has historically gotten wrong:
// a path-shaped id under a namespaced collection (longest-prefix, both axes at once), and a file
// that belongs to NO collection, which must exit 1 rather than guess.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { workspace } from '../helpers/ws.js';

const CONTACTS = {
	id: { generate: '{{ name | slug }}' },
	storage: { suffix: 'contact' },
	schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
};
const TRANSACTIONS = {
	id: { generate: '{{ month }}/{{ label | slug }}' },
	storage: { suffix: 'txn' },
	schema: { type: 'object', required: ['label', 'month'], properties: { label: { type: 'string' }, month: { type: 'string' } } },
};

const fixture = () => workspace({
	namespaces: ['finance'],
	collections: { contacts: CONTACTS, 'finance/transactions': TRANSACTIONS },
	records: {
		contacts: [{ name: 'Jane' }],
		'finance/transactions': [{ label: 'Coffee', month: '2026/03' }],
	},
});

describe('dt locate', () => {
	test('a record path resolves to its ref', () => {
		const { dt } = fixture();
		const r = dt('locate', 'data/contacts/jane.contact.md');
		assert.equal(r.code, 0, r.stderr);
		assert.equal(r.stdout.trim(), 'contacts/jane');
	});

	test('a path-shaped id under a namespaced collection — both slash axes at once', () => {
		const { dt } = fixture();
		const r = dt('locate', 'data/finance/transactions/2026/03/coffee.txn.md');
		assert.equal(r.code, 0, r.stderr);
		assert.equal(r.stdout.trim(), 'finance/transactions/2026/03/coffee');
	});

	test('an absolute path resolves the same as a workspace-relative one', () => {
		const { root, dt } = fixture();
		const r = dt('locate', path.join(root, 'data', 'contacts', 'jane.contact.md'));
		assert.equal(r.code, 0, r.stderr);
		assert.equal(r.stdout.trim(), 'contacts/jane');
	});

	test('a non-record path exits 1 and says so — never a guess', () => {
		const { dt } = fixture();
		const r = dt('locate', 'package.json');
		assert.equal(r.code, 1);
		assert.match(r.stdout, /not a record of any collection/);
	});

	test('--json carries every input, resolved or not, and the exit code still reports the misses', () => {
		const { dt } = fixture();
		const r = dt('locate', 'data/contacts/jane.contact.md', 'package.json', '--json');
		assert.equal(r.code, 1);
		const rows = JSON.parse(r.stdout);
		assert.deepEqual(rows[0], { path: 'data/contacts/jane.contact.md', collection: 'contacts', id: 'jane' });
		assert.deepEqual(rows[1], { path: 'package.json', collection: null, id: null });
	});

	test('a path outside the workspace is a miss, not a crash', () => {
		const { dt } = fixture();
		const r = dt('locate', '/etc/hosts');
		assert.equal(r.code, 1);
		assert.match(r.stdout, /not a record/);
	});
});
