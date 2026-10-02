// Tier 1 — the filter operator set.
//
// The load-bearing property is FAIL-CLOSED: an unknown operator must narrow, never widen. Review
// finding 5 was a typo'd `_nq` in a compiled ui-view matching everything, which showed every user's
// tasks with no signal at all. A filter that silently matches too much is the worst failure mode this
// module has, so it is the first thing asserted.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { matchesFilter, unknownOperators, unknownTokens, tokenValue, VALUE_TOKENS, KNOWN_OPERATORS } from '../../src/filter.js';

const row = { title: 'Fix login', status: 'todo', tags: ['ui', 'bug'], due: '2026-07-28', assignee: null, count: 3 };

describe('fail-closed on unknown operators', () => {
	test('an unknown operator matches NOTHING', () => {
		assert.equal(matchesFilter(row, { status: { _nq: 'done' } }), false);
	});

	test('unknownOperators names them so compile can refuse a bad ui-view', () => {
		assert.deepEqual([...unknownOperators({ status: { _nq: 'x' }, _and: [{ title: { _bogus: 1 } }] })].sort(), ['_bogus', '_nq']);
	});

	test('every operator the implementation handles is declared known', () => {
		for (const op of ['_eq', '_neq', '_in', '_between', '_regex', '_and', '_or', '_icontains']) {
			assert.ok(KNOWN_OPERATORS.has(op), `${op} should be declared`);
		}
	});

	test('a clean filter reports no unknown operators', () => {
		assert.equal(unknownOperators({ status: { _eq: 'todo' } }).size, 0);
	});
});

describe('equality and sets', () => {
	test('a bare value is an implicit _eq', () => {
		assert.equal(matchesFilter(row, { status: 'todo' }), true);
		assert.equal(matchesFilter(row, { status: 'done' }), false);
	});

	test('_eq on an array field is containment', () => {
		assert.equal(matchesFilter(row, { tags: { _eq: 'bug' } }), true);
		assert.equal(matchesFilter(row, { tags: { _eq: 'perf' } }), false);
	});

	test('_in accepts a list', () => {
		assert.equal(matchesFilter(row, { status: { _in: ['todo', 'doing'] } }), true);
		assert.equal(matchesFilter(row, { status: { _in: ['done'] } }), false);
	});

	// SQL semantics, stated in the module header: a negative operator rejects null rather than
	// treating "absent" as "not equal to".
	test('negative operators reject null', () => {
		assert.equal(matchesFilter(row, { assignee: { _neq: 'users/ada' } }), false);
		assert.equal(matchesFilter(row, { assignee: { _nin: ['users/ada'] } }), false);
	});
});

describe('null and empty', () => {
	test('_null and _nnull', () => {
		assert.equal(matchesFilter(row, { assignee: { _null: true } }), true);
		assert.equal(matchesFilter(row, { assignee: { _nnull: true } }), false);
		assert.equal(matchesFilter(row, { status: { _nnull: true } }), true);
	});

	test('_empty treats null, empty string and empty array alike', () => {
		assert.equal(matchesFilter({ a: null }, { a: { _empty: true } }), true);
		assert.equal(matchesFilter({ a: '' }, { a: { _empty: true } }), true);
		assert.equal(matchesFilter({ a: [] }, { a: { _empty: true } }), true);
		assert.equal(matchesFilter({ a: ['x'] }, { a: { _empty: true } }), false);
	});
});

describe('text', () => {
	test('_contains is case-sensitive, _icontains is not', () => {
		assert.equal(matchesFilter(row, { title: { _contains: 'login' } }), true);
		assert.equal(matchesFilter(row, { title: { _contains: 'LOGIN' } }), false);
		assert.equal(matchesFilter(row, { title: { _icontains: 'LOGIN' } }), true);
	});

	test('_starts_with / _ends_with', () => {
		assert.equal(matchesFilter(row, { title: { _starts_with: 'Fix' } }), true);
		assert.equal(matchesFilter(row, { title: { _ends_with: 'login' } }), true);
		assert.equal(matchesFilter(row, { title: { _istarts_with: 'fix' } }), true);
	});

	test('a malformed _regex matches nothing instead of throwing', () => {
		assert.equal(matchesFilter(row, { title: { _regex: '([' } }), false);
		assert.equal(matchesFilter(row, { title: { _regex: '^Fix' } }), true);
	});
});

describe('ranges compare as instants, not strings', () => {
	test('_gte / _lt on a date', () => {
		assert.equal(matchesFilter(row, { due: { _gte: '2026-07-01' } }), true);
		assert.equal(matchesFilter(row, { due: { _lt: '2026-07-01' } }), false);
	});

	test('_between is inclusive', () => {
		assert.equal(matchesFilter(row, { due: { _between: ['2026-07-28', '2026-08-01'] } }), true);
		assert.equal(matchesFilter(row, { due: { _nbetween: ['2026-07-28', '2026-08-01'] } }), false);
	});

	test('offsets are resolved in a range, so a filter agrees with a sort', () => {
		const r = { starts: '2026-07-28T12:00:00+03:00' }; // 09:00Z
		assert.equal(matchesFilter(r, { starts: { _lt: '2026-07-28T10:00:00Z' } }), true);
	});
});

describe('_and / _or', () => {
	test('_and requires every branch', () => {
		assert.equal(matchesFilter(row, { _and: [{ status: 'todo' }, { title: { _contains: 'login' } }] }), true);
		assert.equal(matchesFilter(row, { _and: [{ status: 'todo' }, { title: { _contains: 'nope' } }] }), false);
	});

	test('_or requires one', () => {
		assert.equal(matchesFilter(row, { _or: [{ status: 'done' }, { status: 'todo' }] }), true);
		assert.equal(matchesFilter(row, { _or: [{ status: 'done' }, { status: 'blocked' }] }), false);
	});

	test('top-level keys are ANDed together', () => {
		assert.equal(matchesFilter(row, { status: 'todo', count: 3 }), true);
		assert.equal(matchesFilter(row, { status: 'todo', count: 4 }), false);
	});
});

describe('one-hop relational conditions', () => {
	const resolve = (ref) => ({ 'users/ada': { name: 'Ada', active: true } }[ref]);

	test('a non-operator key resolves the reference and evaluates against the target', () => {
		const r = { assignee: 'users/ada' };
		assert.equal(matchesFilter(r, { assignee: { name: { _eq: 'Ada' } } }, resolve), true);
		assert.equal(matchesFilter(r, { assignee: { name: { _eq: 'Lin' } } }, resolve), false);
	});

	test('an array of refs matches if ANY target matches', () => {
		const r = { attendees: ['users/nobody', 'users/ada'] };
		assert.equal(matchesFilter(r, { attendees: { name: { _eq: 'Ada' } } }, resolve), true);
	});

	// fail-closed again: no resolver, or a dangling ref, must narrow.
	test('no resolver narrows', () => {
		assert.equal(matchesFilter({ assignee: 'users/ada' }, { assignee: { name: { _eq: 'Ada' } } }), false);
	});

	test('a dangling ref narrows', () => {
		assert.equal(matchesFilter({ assignee: 'users/ghost' }, { assignee: { name: { _eq: 'Ada' } } }, resolve), false);
	});
});

describe('degenerate input', () => {
	test('an absent or non-object filter matches everything', () => {
		for (const f of [null, undefined, 'nonsense', 42]) assert.equal(matchesFilter(row, f), true);
	});
});

// The two value tokens, resolved at evaluation against the local clock and zone. Dates a day away
// from today keep these assertions true whenever the suite runs.
describe('value tokens $today and $now', () => {
	const pad = (n) => String(n).padStart(2, '0');
	const day = (offsetDays) => { const d = new Date(); d.setDate(d.getDate() + offsetDays); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

	test('the token set is exactly $today and $now', () => {
		assert.deepEqual(VALUE_TOKENS, ['$today', '$now']);
	});

	test('$today is the local date and $now the local instant with its offset', () => {
		const at = new Date(2026, 2, 5, 9, 7, 3);
		assert.equal(tokenValue('$today', at), '2026-03-05');
		const now = tokenValue('$now', at);
		assert.match(now, /^2026-03-05T09:07:03[+-]\d{2}:\d{2}$/);
		assert.equal(Date.parse(now), at.getTime(), 'the offset makes it the same instant');
	});

	test('a token resolves in an operator, in the equality shorthand and inside a list operand', () => {
		const past = { due: day(-1) };
		const today = { due: day(0) };
		assert.equal(matchesFilter(past, { due: { _lt: '$today' } }), true);
		assert.equal(matchesFilter(today, { due: { _lt: '$today' } }), false);
		assert.equal(matchesFilter(today, { due: '$today' }), true);
		assert.equal(matchesFilter(today, { due: { _in: ['$today'] } }), true);
		assert.equal(matchesFilter(past, { due: { _between: [day(-2), '$today'] } }), true);
	});

	test('$now compares as an instant against a date-time field', () => {
		assert.equal(matchesFilter({ at: '2000-01-01T00:00:00+00:00' }, { at: { _lt: '$now' } }), true);
		assert.equal(matchesFilter({ at: '2999-01-01T00:00:00+00:00' }, { at: { _lt: '$now' } }), false);
	});

	test('an unknown token narrows to nothing, and unknownTokens names it at any depth', () => {
		assert.equal(matchesFilter({ due: '$yesterday' }, { due: '$yesterday' }), false);
		assert.deepEqual([...unknownTokens({ _and: [{ due: { _lt: '$yesterday' } }, { owner: { team: { _in: ['$me'] } } }] })].sort(), ['$me', '$yesterday']);
		assert.equal(unknownTokens({ due: { _lt: '$today' }, at: { _gte: '$now' } }).size, 0);
	});

	test('a value that merely starts with $ is a literal, not a token', () => {
		assert.equal(tokenValue('$100'), undefined);
		assert.equal(unknownTokens({ price: '$100' }).size, 0);
		assert.equal(matchesFilter({ price: '$100' }, { price: '$100' }), true);
	});
});
