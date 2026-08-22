import test from 'node:test';
import assert from 'node:assert/strict';
import { splitRef } from '../../src/ref.js';

const descriptors = new Map([
	['contacts', {}], ['finance/transactions', {}], ['finance/transaction-tags', {}], ['repos', {}],
]);

test('plain collection + id', () => {
	assert.deepEqual(splitRef(descriptors, 'contacts/jane-doe'), { collection: 'contacts', id: 'jane-doe' });
});
test('namespaced collection: split at the end of the DECLARED prefix, not the first slash', () => {
	assert.deepEqual(splitRef(descriptors, 'finance/transactions/2025/03/x-01'),
		{ collection: 'finance/transactions', id: '2025/03/x-01' });
});
test('longest match wins at a boundary (transaction-tags is not shadowed by transactions)', () => {
	assert.deepEqual(splitRef(descriptors, 'finance/transaction-tags/vat'),
		{ collection: 'finance/transaction-tags', id: 'vat' });
});
test('unknown collection throws and names the knowns', () => {
	assert.throws(() => splitRef(descriptors, 'nope/x'), /unknown collection in reference "nope\/x"/);
});
test('bare collection name throws when an id is required', () => {
	assert.throws(() => splitRef(descriptors, 'contacts'), /no record id/);
});
