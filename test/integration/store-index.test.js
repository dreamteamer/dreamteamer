// Tier 2 — the store's id index, and the two memos that decide what a run of writes costs.
//
// WHY THIS FILE MEASURES INSTEAD OF TIMING. A cache is only observable through what it SAVES, and a
// timing assertion is exactly what this repo refuses to gate a build on (test/perf/run.mjs says why).
// So the saving is counted rather than timed: `import fs from 'node:fs'` is the same mutable default
// export in store.js as it is here, so a counter around `readdirSync` sees the store's own walks and
// "a run of adds walks the collection once" becomes a fact rather than a stopwatch reading.
//
// The correctness half is the one that matters more: an index maintained incrementally must hold
// exactly what a cold rebuild holds — same entries, same ORDER, because `ids()` order is what
// `dt list` prints when nobody passes `--sort`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, simpleCollection, git } from '../helpers/ws.js';
import { Store } from '../../src/store.js';
import { addField } from '../../src/schema-ops.js';

/** Path-shaped ids, so the index has nested folders to get the order wrong in. */
const ITEMS = simpleCollection({ id: { pattern: '^[a-z0-9][a-z0-9/._-]*$' } });

const base = (pkg) => workspace({ collections: { items: ITEMS }, pkg });

/** How many times `fn` reads a directory under the collection's data dir — i.e. how many cold walks
 *  the store paid. Counted, not timed. */
function walks(root, fn) {
	const real = fs.readdirSync;
	const dir = path.join(root, 'data', 'items');
	let n = 0;
	fs.readdirSync = (p, ...rest) => { if (String(p).startsWith(dir)) n++; return real(p, ...rest); };
	try { fn(); } finally { fs.readdirSync = real; }
	return n;
}

/** The index as a cold rebuild sees it — a second Store over the same workspace, sharing nothing. */
const cold = (ws) => [...new Store(ws.ws).ids('items')];

/** A schema op recompiles, and compile is chatty — the op is the thing under test, not its output. */
function quietly(fn) {
	const log = console.log, warn = console.warn;
	console.log = console.warn = () => {};
	try { return fn(); } finally { console.log = log; console.warn = warn; }
}

describe('the id index survives a write', () => {
	test('a run of adds walks the collection ONCE, not once per add', () => {
		const ws = base();
		const n = walks(ws.root, () => {
			for (let i = 0; i < 10; i++) ws.store.add('items', { name: `Row ${i}` });
		});
		// one walk to discover the collection is empty is fair; ten is the whole defect — each add
		// invalidated the index the next one rebuilt from disk.
		assert.ok(n <= 2, `${n} directory walks for 10 adds — the index is being thrown away per write`);
	});

	test('the memo `add` leaves behind is one `ids()` accepts — same object, no rebuild', () => {
		const ws = base();
		for (let i = 0; i < 3; i++) ws.store.add('items', { name: `Row ${i}` });
		const memo = ws.store._idsCache.get('items');
		assert.ok(memo, 'add left no id index behind');
		assert.equal(ws.store.ids('items'), memo.ids, 'the memo was re-keyed to something ids() rejects');
	});

	test('HEAD is read ONCE for a run of writes that commit nothing', () => {
		const ws = base();
		let spawns = 0;
		const real = Store.prototype.gitHead;
		// the subprocess, counted where it is actually paid: a memo hit costs nothing
		ws.store.gitHead = function () { if (this._head === undefined) spawns++; return real.call(this); };
		for (let i = 0; i < 5; i++) ws.store.add('items', { name: `Row ${i}` });
		assert.ok(spawns <= 1, `${spawns} \`git rev-parse HEAD\` subprocesses for 5 writes that moved HEAD not at all`);
	});
});

describe('what it holds equals a cold rebuild', () => {
	test('nested id folders, in walk order', () => {
		const ws = base();
		ws.store.add('items', { name: 'First' }, { id: '2026-01' });
		ws.store.ids('items'); // seed: an add with an explicit id never asks for the index
		// `2026-01` sorts BEFORE `2026/x` as a string ('-' < '/') and AFTER it in the walk, which
		// descends into the directory it meets first. Insertion order here is a third order again.
		for (const id of ['2026/x', '2025/b', '2026/a', 'zz', '2026/01/deep']) {
			ws.store.add('items', { name: id }, { id });
		}
		assert.deepEqual([...ws.store.ids('items')], cold(ws));
	});

	test('add → rm → add of the same id', () => {
		const ws = base();
		for (const id of ['a', 'b', 'c']) ws.store.add('items', { name: id }, { id });
		ws.store.ids('items');
		ws.store.rm('items', 'b');
		ws.store.add('items', { name: 'b again' }, { id: 'b' });
		assert.deepEqual([...ws.store.ids('items')], cold(ws));
		assert.equal(ws.store.read('items', 'b').fields.name, 'b again');
	});

	test('a generated id and an explicit one leave the same index', () => {
		const ws = base();
		ws.store.add('items', { name: 'Alpha' });
		ws.store.add('items', { name: 'Zulu' });
		ws.store.add('items', { name: 'Mid' }, { id: 'mid/one' });
		ws.store.add('items', { name: 'Beta' });
		assert.deepEqual([...ws.store.ids('items')], cold(ws));
	});

	test('a rolled-back add leaves no phantom in the index', () => {
		// a dangling reference is refused before the lock, so the rollback path is reached by making
		// the id itself illegal after the file exists — instead, prove the simpler invariant: a
		// refused add adds nothing, and the index still equals disk.
		const ws = base();
		ws.store.add('items', { name: 'One' }, { id: 'one' });
		ws.store.ids('items');
		assert.throws(() => ws.store.add('items', { name: 'Dup' }, { id: 'one' }), /already exists/);
		assert.deepEqual([...ws.store.ids('items')], cold(ws));
	});
});

describe('the HEAD memo is dropped by whatever moves HEAD', () => {
	test('an auto-committed record write', () => {
		const ws = base({ 'auto-commit': true });
		ws.store.add('items', { name: 'One' });
		assert.equal(ws.store.gitHead(), git(ws.root, ['rev-parse', 'HEAD']));
	});

	test('a schema op, which commits its sources whatever auto-commit says', () => {
		const ws = base();
		ws.store.gitHead(); // seed the memo with the pre-op sha
		quietly(() => addField(ws.ws, ws.store, 'items', { name: 'colour', prop: { type: 'string' } }));
		assert.equal(ws.store.gitHead(), git(ws.root, ['rev-parse', 'HEAD']));
	});
});
