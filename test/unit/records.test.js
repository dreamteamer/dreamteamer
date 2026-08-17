// Tier 1 — the record primitives shared by the store (hard, write-time) and check (soft, report-only).
//
// `assertSafeId` gets the most attention because it is a SECURITY boundary, not a validation nicety:
// review finding 1 was an escaping `--id` that wrote a record outside the repo and orphaned others
// inside it. Every shape that could climb out is enumerated here.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeId, parseRecordText, patternRe, unknownFields, EXT } from '../../src/records.js';

const md = { storage: { codec: 'md' } };

describe('assertSafeId', () => {
	test('accepts a plain id and a nested path id', () => {
		for (const id of ['ada', '2026-07-28--fix-login', '2026/07/kickoff', 'a-b_c.d']) {
			assert.doesNotThrow(() => assertSafeId(id), `${id} should be allowed`);
		}
	});

	test('refuses traversal, absolute paths and backslashes', () => {
		for (const id of ['../escape', 'a/../../b', '/etc/passwd', 'a\\b', './x', 'a//b', '..', '.']) {
			assert.throws(() => assertSafeId(id), /invalid id/, `${id} must be refused`);
		}
	});

	test('refuses empties and non-strings', () => {
		for (const id of ['', null, undefined, 42, {}, []]) assert.throws(() => assertSafeId(id), /invalid id/);
	});
});

describe('parseRecordText', () => {
	test('splits frontmatter from the body and assigns the body field', () => {
		const fields = parseRecordText('---\ntitle: Kickoff\n---\nAda walked through it.\n', md, 'body');
		assert.equal(fields.title, 'Kickoff');
		assert.equal(fields.body.trim(), 'Ada walked through it.');
	});

	test('a frontmatter-less file is all body', () => {
		const fields = parseRecordText('just prose\n', md, 'body');
		assert.equal(fields.body.trim(), 'just prose');
	});

	test('an empty body does not create the body field', () => {
		const fields = parseRecordText('---\ntitle: T\n---\n', md, 'body');
		assert.equal(fields.body, undefined);
	});

	test('no body field declared means the body is dropped', () => {
		const fields = parseRecordText('---\ntitle: T\n---\nprose\n', md, undefined);
		assert.deepEqual(fields, { title: 'T' });
	});

	test('CRLF frontmatter parses', () => {
		assert.equal(parseRecordText('---\r\ntitle: T\r\n---\r\nbody\r\n', md, 'body').title, 'T');
	});

	// CLAUDE.md: dreamteamer parses with CORE_SCHEMA so an unquoted date stays a STRING here, even
	// though a default-schema YAML reader would turn it into a timestamp.
	test('an unquoted date stays a string', () => {
		const fields = parseRecordText('---\ndue: 2026-07-28\n---\n', md, 'body');
		assert.equal(typeof fields.due, 'string');
		assert.equal(fields.due, '2026-07-28');
	});

	test('yaml and json codecs parse whole-file', () => {
		assert.equal(parseRecordText('name: Ada\n', { storage: { codec: 'yaml' } }).name, 'Ada');
		assert.equal(parseRecordText('{"name":"Ada"}', { storage: { codec: 'json' } }).name, 'Ada');
	});
});

describe('unknownFields — the typo detector', () => {
	const schema = { properties: { title: { type: 'string' }, status: { type: 'string' } } };

	test('names keys the schema does not declare', () => {
		assert.deepEqual(unknownFields(schema, { title: 'T', assinee: 'x' }), ['assinee']);
	});

	test('a clean record has none', () => {
		assert.deepEqual(unknownFields(schema, { title: 'T', status: 'todo' }), []);
	});

	// A schema that declares nothing cannot distinguish a typo from a field, so it must not guess.
	test('a schema with no properties accepts anything', () => {
		assert.deepEqual(unknownFields({}, { anything: 1 }), []);
	});
});

describe('patternRe', () => {
	test('compiles with the unicode flag so property escapes work', () => {
		assert.ok(patternRe('^[a-z0-9-]+$').test('fix-login'));
		assert.ok(patternRe('^\\p{Letter}+$', 'u').test('שלום'));
	});

	// A malformed pattern throws here rather than silently matching nothing — and compile refuses one
	// up front (test/integration/compile.test.js) so a descriptor can never carry it into a write path.
	test('a malformed pattern throws rather than matching everything', () => {
		assert.throws(() => patternRe('(['), /Invalid regular expression/);
	});
});

describe('EXT', () => {
	test('maps every codec the descriptor schema allows', () => {
		assert.deepEqual(EXT, { md: '.md', yaml: '.yaml', json: '.json' });
	});
});
