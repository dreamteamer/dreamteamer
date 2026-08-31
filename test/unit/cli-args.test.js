// Tier 1 — the CLI's argument parser, which is one pure function every verb runs before anything
// else happens.
//
// The property under test is that NOTHING the operator typed is dropped. A flag assigned twice used
// to keep the last value and say nothing: `dt add c --tags a --tags b` wrote `[b]`, `dt list c
// --filter a=1 --filter b=2` returned rows the caller had excluded, and both exited 0. So a repeat
// promotes to an array here, and every consumer has to state what a repeat means for it — which is
// exactly what the integration tests assert.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../../src/collections-cli.js';

describe('parseArgs — the three flag spellings', () => {
	test('--flag value, --flag=value and a bare --flag', () => {
		const { flags, pos } = parseArgs(['--name', 'Jane', '--email=j@x.invalid', '--json']);
		assert.deepEqual(flags, { name: 'Jane', email: 'j@x.invalid', json: true });
		assert.deepEqual(pos, []);
	});

	test('positionals keep their order, wherever the flags sit', () => {
		const { pos } = parseArgs(['jane', '--name', 'Jane', 'tags=a']);
		assert.deepEqual(pos, ['jane', 'tags=a']);
	});

	test('a value that looks like a flag is NOT consumed as one', () => {
		// the pre-existing rule, restated because promote-on-repeat rewrote the loop around it
		const { flags } = parseArgs(['--drop', '--json']);
		assert.deepEqual(flags, { drop: true, json: true });
	});
});

describe('a repeated flag promotes to an array', () => {
	test('twice, in the order typed', () => {
		assert.deepEqual(parseArgs(['--tags', 'a', '--tags', 'b']).flags, { tags: ['a', 'b'] });
	});

	test('three times, still flat — not a nested array', () => {
		assert.deepEqual(parseArgs(['--tags', 'a', '--tags', 'b', '--tags', 'c']).flags, { tags: ['a', 'b', 'c'] });
	});

	test('the two spellings mix', () => {
		assert.deepEqual(parseArgs(['--tags=a', '--tags', 'b']).flags, { tags: ['a', 'b'] });
	});

	test('a bare repeat carries the boolean, so the consumer can see what was typed', () => {
		assert.deepEqual(parseArgs(['--tags', 'a', '--tags']).flags, { tags: ['a', true] });
	});

	test('one sighting is still a plain value — nothing is wrapped', () => {
		assert.equal(parseArgs(['--tags', 'a']).flags.tags, 'a');
	});

	test('different keys are untouched by a repeat of another', () => {
		assert.deepEqual(parseArgs(['--filter', 'a=1', '--filter', 'b=2', '--json']).flags,
			{ filter: ['a=1', 'b=2'], json: true });
	});
});
