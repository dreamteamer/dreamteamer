// Tier 2 — `dt reorder`: the manual order lives in the collection's one `type: position` field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workspace, writeCollection, compileQuietly, compileError, dt } from '../helpers/ws.js';

const CARDS = (extra = {}) => ({ description: 'A card.', ids: { from: '{{ name | slug }}' }, fields: { name: { type: 'string', required: true }, ...extra, notes: { type: 'markdown', body: true } } });

test('reorder writes the position field, and the result passes check', () => {
	const w = workspace({ compile: false });
	writeCollection(w.root, 'cards', CARDS({ position: { type: 'position' } }));
	compileQuietly(w.ws);
	for (const n of ['A', 'B', 'C']) dt(w.root, 'add', 'cards', '--name', n);
	assert.equal(dt(w.root, 'reorder', 'cards', '--init').code, 0);
	const r = dt(w.root, 'reorder', 'cards/c', '--top');
	assert.equal(r.code, 0, r.stderr);
	const rows = JSON.parse(dt(w.root, 'list', 'cards', '--sort', 'position', '--json').stdout).map((x) => x.id);
	assert.deepEqual(rows, ['c', 'a', 'b']);
	assert.equal(dt(w.root, 'check').code, 0);
});

test('reorder on a collection without a position field is refused, naming the type', () => {
	const w = workspace({ compile: false });
	writeCollection(w.root, 'cards', CARDS());
	compileQuietly(w.ws);
	dt(w.root, 'add', 'cards', '--name', 'A');
	const r = dt(w.root, 'reorder', 'cards/a', '--top');
	assert.notEqual(r.code, 0);
	assert.match(r.stderr, /has no `type: position` field/);
});

test('a second position field fails compile; `dt move` is not a verb', () => {
	const w = workspace({ compile: false });
	writeCollection(w.root, 'cards', CARDS({ a: { type: 'position' }, b: { type: 'position' } }));
	assert.match(compileError(w.ws), /one manual order/);
	const w2 = workspace({ compile: false });
	writeCollection(w2.root, 'cards', CARDS({ position: { type: 'position' } }));
	compileQuietly(w2.ws);
	assert.notEqual(dt(w2.root, 'move', 'cards', '--init').code, 0);
});
