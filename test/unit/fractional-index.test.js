// Tier 1 — the generator and the comparator must agree.
//
// `compareValues` (temporal.js) ends in `localeCompare`, which is LOCALE-AWARE. The library's default
// base-62 alphabet therefore mis-sorts in this engine — the same trap that breaks fractional indexing
// on Postgres under `en_US.utf8` instead of `C`. The a-z alphabet is the fix, and the first test here
// is its guard: it asserts base-62 fails, so nobody deletes the `DIGITS` argument as noise.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyBetween } from 'fractional-indexing';
import { keyBetween } from '../../src/fractional-index.js';
import { sortRows, parseTemporal } from '../../src/temporal.js';

const order = (keys) => sortRows(keys.map((r) => ({ r })), 'r').map((x) => x.r);

describe('the alphabet is load-bearing', () => {
	test('base-62 keys MIS-SORT under compareValues — this is why DIGITS exists', () => {
		let k = null;
		const b62 = [];
		for (let i = 0; i < 3; i++) { k = generateKeyBetween(null, k); b62.unshift(k); }
		assert.deepEqual(b62, ['Zy', 'Zz', 'a0'], 'the library changed its prepend sequence');
		assert.notDeepEqual(order(b62), b62, 'if this now passes, base-62 became safe here and this module can be simplified');
	});

	test('a-z keys sort identically under compareValues and codepoint order', () => {
		const keys = [];
		let p = null;
		for (let i = 0; i < 50; i++) { p = keyBetween(p, null); keys.push(p); }
		assert.deepEqual(order(keys), keys);
		assert.deepEqual(order(keys), [...keys].sort());
	});
});

describe('key shape', () => {
	test('every key is lowercase a-z only', () => {
		let p = null;
		for (let i = 0; i < 200; i++) { p = keyBetween(p, null); assert.match(p, /^[a-z]+$/); }
	});

	test('no key parses as a number or a temporal — compareValues must stay on localeCompare', () => {
		let p = null;
		for (let i = 0; i < 200; i++) {
			p = keyBetween(p, null);
			assert.ok(Number.isNaN(Number(p)), `${p} parsed as a number`);
			assert.equal(parseTemporal(p), null, `${p} parsed as a temporal`);
		}
	});

	test('keyBetween(null, null) is a valid first key', () => {
		assert.match(keyBetween(null, null), /^[a-z]+$/);
	});

	test('equal bounds throw rather than returning a duplicate', () => {
		const k = keyBetween(null, null);
		assert.throws(() => keyBetween(k, k));
	});
});

describe('growth stays bounded', () => {
	// Deterministic pseudo-random: a test may not call Math.random, and the DISTRIBUTION is the
	// whole point — reordering spread across a list behaves completely differently from reordering
	// that keeps splitting one gap. Both are asserted, separately.
	const lcg = (seed) => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

	test('realistic reordering — 1000 appends, 500 prepends, 3000 scattered splices — stays short', () => {
		const keys = [];
		let p = null;
		for (let i = 0; i < 1000; i++) { p = keyBetween(p, null); keys.push(p); }
		for (let i = 0; i < 500; i++) keys.unshift(keyBetween(null, keys[0]));
		const rand = lcg(42);
		for (let d = 0; d < 3000; d++) {
			const i = Math.floor(rand() * (keys.length - 1));
			keys.splice(i + 1, 0, keyBetween(keys[i], keys[i + 1]));
		}
		const max = Math.max(...keys.map((k) => k.length));
		assert.ok(max <= 10, `max key length ${max} — a naive midpoint generator measured 200 here`);
		assert.deepEqual(order(keys), keys);
	});

	test('adversarial — 500 drops into the SAME gap stay exactly ordered, at the cost of length', () => {
		// This is the pathological case (always dropping just below the same card). Keys grow, which
		// is the documented tradeoff; what must NOT happen is a wrong order or a duplicate key.
		const keys = [keyBetween(null, null)];
		keys.push(keyBetween(keys[0], null));
		for (let d = 0; d < 500; d++) keys.splice(1, 0, keyBetween(keys[0], keys[1]));
		assert.equal(new Set(keys).size, keys.length, 'a duplicate key would make order undefined');
		assert.deepEqual(order(keys), keys);
		const max = Math.max(...keys.map((k) => k.length));
		assert.ok(max < 500, `max key length ${max} — should grow sub-linearly, not one char per drop`);
	});
});

describe('the blank contract move() depends on', () => {
	test('a record with no sort value sorts FIRST', () => {
		assert.deepEqual(order(['m', '', 'a']), ['', 'a', 'm']);
	});
});
