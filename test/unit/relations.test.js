// test/unit/relations.test.js — pure unit: plain descriptor objects, no workspace
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relationsOf, mirrorFieldsOf, expectedMirrors } from '../../src/relations.js';

const D = new Map([
	['meetings', { name: 'meetings', schema: { properties: { name: { type: 'string' } } } }],
	['recordings', { name: 'recordings', schema: { properties: {
		meeting: { type: 'string', 'x-reference': 'meetings', 'x-inverse': 'recordings' },
	} } }],
	['summaries', { name: 'summaries', schema: { properties: {
		meeting: { type: 'string', 'x-reference': 'meetings', 'x-unique': true, 'x-inverse': 'summary' },
	} } }],
	['analyses', { name: 'analyses', schema: { properties: {
		meetings: { type: 'array', items: { type: 'string', 'x-reference': 'meetings', 'x-inverse': 'analyses', 'x-on-delete': 'set-null' } },
	} } }],
]);

test('relationsOf decodes kind, cardinality and on-delete from the holder', () => {
	const rels = relationsOf(D);
	assert.deepEqual(rels.map((r) => [r.owner, r.field, r.target, r.mirror, r.kind, r.onDelete]), [
		['recordings', 'meeting', 'meetings', 'recordings', 'm2o', 'restrict'],
		['summaries', 'meeting', 'meetings', 'summary', 'o2o', 'restrict'],
		['analyses', 'meetings', 'meetings', 'analyses', 'm2m', 'set-null'],
	]);
});

test('mirrorFieldsOf inverts to the target side', () => {
	const m = mirrorFieldsOf(D, 'meetings');
	assert.deepEqual([...m.keys()].sort(), ['analyses', 'recordings', 'summary']);
	assert.equal(m.get('summary').unique, true);
});

test('expectedMirrors computes sorted arrays / scalars per target', () => {
	const rel = relationsOf(D)[0]; // recordings.meeting
	const owners = [
		{ id: 'b', fields: { meeting: 'meetings/x' } },
		{ id: 'a', fields: { meeting: 'meetings/x' } },
		{ id: 'c', fields: {} },
	];
	const exp = expectedMirrors(rel, owners);
	assert.deepEqual(exp.get('x'), ['recordings/a', 'recordings/b']); // sorted by ref string
	const uni = relationsOf(D)[1]; // summaries.meeting (unique → scalar)
	assert.deepEqual(expectedMirrors(uni, [{ id: 's1', fields: { meeting: 'meetings/x' } }]).get('x'), 'summaries/s1');
});
