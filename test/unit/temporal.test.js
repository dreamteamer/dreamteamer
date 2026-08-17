// Tier 1 — dates and ordering.
//
// CLAUDE.md names this the trap: a `date-time` keeps its LOCAL OFFSET rather than being folded to Z,
// because these are markdown files a human reads in a git diff. Which means ordering has to compare
// INSTANTS, and a `localeCompare` puts `…T12:00+03:00` after `…T11:00+01:00` — the earlier moment.
// That regression is cheap to reintroduce and invisible until someone notices a board sorted wrong,
// so it gets a test that fails loudly.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseTemporal, normalizeTemporal, normalizeRecord, compareValues, sortRows } from '../../src/temporal.js';

describe('normalizeTemporal', () => {
	test('a human date-time gets the local offset stamped on, not folded to Z', () => {
		const out = normalizeTemporal('2026-07-28 12:00', 'date-time');
		assert.match(out, /^2026-07-28T12:00:00[+-]\d{2}:\d{2}$|^2026-07-28T12:00:00Z$/);
		// the wall-clock time the operator typed must survive verbatim
		assert.ok(out.startsWith('2026-07-28T12:00:00'));
	});

	test('accepts the datetime-local widget spelling and the CLI spelling identically', () => {
		assert.equal(normalizeTemporal('2026-07-28T12:00', 'date-time'), normalizeTemporal('2026-07-28 12:00', 'date-time'));
	});

	test('an explicit offset is preserved exactly', () => {
		assert.equal(normalizeTemporal('2026-07-28T12:00:00+03:00', 'date-time'), '2026-07-28T12:00:00+03:00');
	});

	test('a plain date stays a plain date', () => {
		assert.equal(normalizeTemporal('2026-07-28', 'date'), '2026-07-28');
	});

	test('unparseable input is returned untouched for the validator to reject', () => {
		assert.equal(normalizeTemporal('not a date', 'date-time'), 'not a date');
	});
});

describe('compareValues — instants, never strings', () => {
	// THE regression test. Lexically '2026-07-28T12:00:00+03:00' > '2026-07-28T11:00:00+01:00',
	// but 12:00+03:00 is 09:00Z and 11:00+01:00 is 10:00Z, so the first is EARLIER.
	test('offsets are resolved before comparing', () => {
		const later = '2026-07-28T11:00:00+01:00';   // 10:00Z
		const earlier = '2026-07-28T12:00:00+03:00'; // 09:00Z
		assert.ok(compareValues(earlier, later) < 0, 'the +03:00 value is the earlier instant');
		assert.ok(compareValues(later, earlier) > 0);
		assert.ok(later.localeCompare(earlier) < 0, 'a string compare gets this backwards — hence the test');
	});

	test('equal instants in different offsets compare equal', () => {
		assert.equal(compareValues('2026-07-28T12:00:00+03:00', '2026-07-28T09:00:00Z'), 0);
	});

	test('non-temporal values still order sensibly', () => {
		assert.ok(compareValues('apple', 'banana') < 0);
		assert.ok(compareValues(2, 10) < 0);
	});
});

describe('sortRows', () => {
	const rows = () => [
		{ id: 'b', starts: '2026-07-28T11:00:00+01:00' }, // 10:00Z
		{ id: 'a', starts: '2026-07-28T12:00:00+03:00' }, // 09:00Z
		{ id: 'c', starts: '2026-07-28T12:00:00Z' },      // 12:00Z
	];

	test('ascending is by instant', () => {
		assert.deepEqual(sortRows(rows(), 'starts').map((r) => r.id), ['a', 'b', 'c']);
	});

	test('a leading minus reverses', () => {
		assert.deepEqual(sortRows(rows(), '-starts').map((r) => r.id), ['c', 'b', 'a']);
	});

	test('no sort key leaves the order alone', () => {
		assert.deepEqual(sortRows(rows(), undefined).map((r) => r.id), ['b', 'a', 'c']);
	});
});

describe('normalizeRecord', () => {
	test('normalizes only the fields the schema calls temporal', () => {
		const schema = {
			type: 'object',
			properties: {
				starts: { type: 'string', format: 'date-time' },
				due: { type: 'string', format: 'date' },
				note: { type: 'string' },
			},
		};
		const fields = { starts: '2026-07-28 12:00', due: '2026-07-28', note: '2026-07-28 12:00' };
		normalizeRecord(schema, fields);
		assert.ok(fields.starts.includes('T12:00:00'));
		assert.equal(fields.due, '2026-07-28');
		assert.equal(fields.note, '2026-07-28 12:00', 'a plain string field is never rewritten');
	});
});

describe('parseTemporal', () => {
	test('returns a comparable instant for the shapes records actually carry', () => {
		for (const v of ['2026-07-28', '2026-07-28T12:00', '2026-07-28T12:00:00Z', '2026-07-28T12:00:00+03:00']) {
			assert.equal(typeof parseTemporal(v), 'number', `${v} should parse`);
			assert.ok(Number.isFinite(parseTemporal(v)));
		}
	});

	test('returns null for things that are not dates', () => {
		for (const v of ['hello', '', null, undefined, {}]) assert.equal(parseTemporal(v), null);
	});
});
