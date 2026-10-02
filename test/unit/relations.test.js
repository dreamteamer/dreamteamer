// test/unit/relations.test.js — pure unit: plain descriptor objects, no workspace
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relationsOf, expectedMirrors } from '../../src/relations.js';

// compiled descriptors: a relation is declared once, on the mirror (`mirror_of`), and the owner's
// reference carries the cardinality (`many`, `unique`) and `on_delete`
const compiled = (name, fields) => ({ name, compiled: { fields } });
const D = new Map([
	['meetings', compiled('meetings', {
		name: { type: 'string' },
		recordings: { type: 'recordings', many: true, mirror_of: 'meeting' },
		summary: { type: 'summaries', mirror_of: 'meeting' },
		analyses: { type: 'analyses', many: true, mirror_of: 'meetings' },
	})],
	['recordings', compiled('recordings', { meeting: { type: 'meetings' } })],
	['summaries', compiled('summaries', { meeting: { type: 'meetings', unique: true } })],
	['analyses', compiled('analyses', { meetings: { type: 'meetings', many: true, on_delete: 'set-null' } })],
]);

test('relationsOf decodes kind, cardinality and on-delete from the holder', () => {
	const rels = relationsOf(D);
	assert.deepEqual(rels.map((r) => [r.owner, r.field, r.target, r.mirror, r.kind, r.onDelete]), [
		['recordings', 'meeting', 'meetings', 'recordings', 'm2o', 'restrict'],
		['summaries', 'meeting', 'meetings', 'summary', 'o2o', 'restrict'],
		['analyses', 'meetings', 'meetings', 'analyses', 'm2m', 'set-null'],
	]);
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

test('expectedMirrors dedupes — the store writes a set, so this must compute one', () => {
	// I2. `dt add analyses --meetings meetings/x,meetings/x` is accepted (an authored array has no
	// uniqueItems), the store writes ONE mirror entry, and check compares against this. Appending
	// blind made check call a correct mirror stale and `relations rebuild` WRITE the duplicate — the
	// documented repair producing the state it was run to fix.
	const m2m = relationsOf(D)[2]; // analyses.meetings
	const exp = expectedMirrors(m2m, [{ id: 'a1', fields: { meetings: ['meetings/x', 'meetings/x'] } }]);
	assert.deepEqual(exp.get('x'), ['analyses/a1']);
});
