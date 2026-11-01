// stubFields — which of a record's fields a stub must carry to validate on its own (cr-dt-003): the
// schema's root `required`, plus each conditional branch's `then.required` whose `if` holds for THIS
// record, intersected with what the record actually carries. Nothing optional, nothing a branch that
// does not apply requires — a stub is read by every workspace that reads this one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { stubFields } from '../../src/records.js';

const ajv = new Ajv({ strict: false });
const holds = (fields) => (s) => ajv.compile(s)(fields);
const SCHEMA = {
	required: ['name', 'by'],
	allOf: [
		{ if: { required: ['by'], properties: { by: { enum: ['person', 'agent'] } } }, then: { required: ['why'] } },
		{ if: { required: ['by'], properties: { by: { const: 'unknown' } } }, then: { required: ['source'] } },
	],
};

test('the root required list only, when no branch applies', () => {
	const rec = { name: 'x', by: 'other', why: 'w', source: 's', extra: 1 };
	assert.deepEqual(stubFields(SCHEMA, rec, holds(rec)), ['name', 'by']);
});

test("a branch whose if holds adds its then.required; the other branch's does not", () => {
	const agent = { name: 'x', by: 'agent', why: 'w', source: 's' };
	assert.deepEqual(stubFields(SCHEMA, agent, holds(agent)), ['name', 'by', 'why']);
	const unknown = { name: 'x', by: 'unknown', why: 'w', source: 's' };
	assert.deepEqual(stubFields(SCHEMA, unknown, holds(unknown)), ['name', 'by', 'source']);
});

test('a required key the record lacks is not invented', () => {
	const rec = { name: 'x' };
	assert.deepEqual(stubFields(SCHEMA, rec, holds(rec)), ['name']);
});

test('no schema, no fields', () => {
	assert.deepEqual(stubFields({}, { name: 'x' }, () => true), []);
});
