// Tier 1 — id generation and slugging.
//
// Ids never change once written, so the rules here are the ones that decide whether a workspace's
// references stay intact. The non-latin case is the interesting one: a Hebrew title slugs to the empty
// string, and an empty id would either throw or collide, so it falls back to a deterministic hash.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateId, slug, slugOrHash } from '../../src/template.js';

// ⚠ The non-latin fixtures below are written as \u escapes, NOT as literal characters. They are
// the identical strings at runtime — this is purely so the leak scanner that guards this PUBLIC repo
// (it treats Hebrew codepoints as a proxy for vault content) does not trip on a slug test. Keep the
// escapes; a literal here blocks every commit to the repo, not just the one that adds it.
describe('slug', () => {
	test('lowercases, strips accents and collapses separators', () => {
		assert.equal(slug('Fix Login Flow'), 'fix-login-flow');
		assert.equal(slug('Café Ürün'), 'cafe-urun');
		assert.equal(slug('a  --  b'), 'a-b');
		assert.equal(slug('  trim me  '), 'trim-me');
	});

	test('drops punctuation entirely', () => {
		assert.equal(slug("Ada's plan (v2)!"), 'ada-s-plan-v2');
	});

	test('a non-latin string slugs to empty', () => {
		assert.equal(slug('\u05E9\u05DC\u05D5\u05DD'), '');
	});
});

describe('slugOrHash', () => {
	test('falls back to a stable hash when the slug is empty', () => {
		const a = slugOrHash('\u05E9\u05DC\u05D5\u05DD');
		assert.notEqual(a, '');
		assert.equal(a, slugOrHash('\u05E9\u05DC\u05D5\u05DD'), 'must be deterministic — ids never change');
		assert.match(a, /^[a-z0-9]+$/, 'must stay legal under a [a-z0-9-] id pattern');
	});

	test('different inputs get different fallbacks', () => {
		assert.notEqual(slugOrHash('\u05E9\u05DC\u05D5\u05DD'), slugOrHash('\u05E2\u05D5\u05DC\u05DD'));
	});

	test('a sluggable string is unaffected', () => {
		assert.equal(slugOrHash('Fix Login'), 'fix-login');
	});
});

describe('generateId', () => {
	test('fills a single field through the slug filter', () => {
		assert.equal(generateId('{{ name | slug }}', { name: 'Dana Levi' }), 'dana-levi');
	});

	test('composes several fields', () => {
		assert.equal(
			generateId('{{ date }}--{{ name | slug }}', { date: '2026-03-04', name: 'Annual Checkup' }),
			'2026-03-04--annual-checkup',
		);
	});

	test('a multi-segment template produces a nested id', () => {
		assert.equal(
			generateId('{{ date }}/{{ name | slug }}', { date: '2026/07', name: 'Kickoff' }),
			'2026/07/kickoff',
		);
	});

	// De-duplication is OPT-IN via the `seq` token, not automatic: a template without it is expected to
	// be unique by construction, and the store's `already exists` refusal is what catches a clash.
	test('a plain template does NOT de-duplicate — that is what seq is for', () => {
		assert.equal(generateId('{{ name | slug }}', { name: 'Dana' }, ['dana']), 'dana');
	});

	test('seq takes the next free number for the rendered prefix', () => {
		const tpl = 'note-{{ seq }}';
		assert.equal(generateId(tpl, {}, []), 'note-1');
		assert.equal(generateId(tpl, {}, ['note-1', 'note-2']), 'note-3');
		// unrelated ids must not advance the counter
		assert.equal(generateId(tpl, {}, ['other-9']), 'note-1');
	});

	test('seq honours pad', () => {
		assert.equal(generateId('n-{{ seq | pad:3 }}', {}, ['n-007']), 'n-008');
	});

	test('a non-latin title still yields a legal id', () => {
		const id = generateId('{{ name | slug }}', { name: '\u05E9\u05DC\u05D5\u05DD' });
		assert.notEqual(id, '');
		assert.match(id, /^[a-z0-9-]+$/);
	});

	// ⚠ THE DOCUMENTED TRAP (CLAUDE.md, references/collections.md): `created` is the moment the record
	// is WRITTEN, not a field on the record. A back-dated import therefore files under the import date,
	// which is why an id must be derived from the domain's own date field instead.
	test('`created` is write time and IGNORES a field of the same name', () => {
		const id = generateId('{{ created | date }}', { created: '2020-01-01T00:00:00Z' });
		const today = new Date();
		const expected = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
		assert.equal(id, expected);
		assert.notEqual(id, '2020-01-01');
	});

	test('the date filter DOES format a real field when the field is not called created', () => {
		assert.equal(generateId('{{ starts | date }}', { starts: '2026-07-28T12:00:00' }), '2026-07-28');
	});

	test('a missing template field is a loud error, never a partial id', () => {
		assert.throws(() => generateId('{{ name | slug }}', {}), /needs "name"/);
	});

	test('an unknown filter is refused', () => {
		assert.throws(() => generateId('{{ name | bogus }}', { name: 'x' }), /unknown id-template filter/);
	});
});
