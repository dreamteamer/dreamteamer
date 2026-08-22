import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { parseEnvValues, renderTemplate } from '../../src/env-vars.js';

const env = parseEnvValues('FILES_FOLDER=/My Drive/hq\n# comment\nSECRET_KEY=shh\nQUOTED="a b"\n');
const ctx = { env, workspaceFolder: '/ws', declared: ['FILES_FOLDER'] };

test('parses values, comments, quotes', () => {
	assert.equal(env.get('FILES_FOLDER'), '/My Drive/hq');
	assert.equal(env.get('QUOTED'), 'a b');
});
test('renders a declared env var', () => {
	assert.equal(renderTemplate('${env:FILES_FOLDER}/inbox/x.pdf', ctx), '/My Drive/hq/inbox/x.pdf');
});
test('workspaceFolder and userHome', () => {
	assert.equal(renderTemplate('${workspaceFolder}/media/a.m4a', ctx), '/ws/media/a.m4a');
	assert.equal(renderTemplate('${userHome}/x', ctx), os.homedir() + '/x');
});
test('undeclared env key is refused, naming the declaration site', () => {
	assert.throws(() => renderTemplate('${env:SECRET_KEY}', ctx), /not declared in dreamteamer\.vars/);
});
test('declared but unset key fails loudly', () => {
	const c2 = { ...ctx, declared: ['FILES_FOLDER', 'MISSING'] };
	assert.throws(() => renderTemplate('${env:MISSING}', c2), /declared but has no value/);
});
test('un-namespaced ${VAR} is inert — prose survives', () => {
	assert.equal(renderTemplate('mentions ${VAR} and ${filesFolder}', ctx), 'mentions ${VAR} and ${filesFolder}');
});
test('unknown variable in the grammar fails listing supported', () => {
	assert.throws(() => renderTemplate('${config:editor}', ctx), /supported: \$\{env:NAME\}, \$\{workspaceFolder\}, \$\{userHome\}/);
});
test('multiple substitutions in one string', () => {
	assert.equal(renderTemplate('${workspaceFolder}:${env:FILES_FOLDER}', ctx), '/ws:/My Drive/hq');
});

// Invented fixture shaped like this vault's real .env — key names only, values are all made up.
// (Never read a real .env for this: a prior attempt leaked live credentials this way.)
test('parses a multi-key single-line .env shape with invented values', () => {
	const text = [
		'# invented fixture — not real credentials',
		'export SOME_TOKEN=tok_example_123',
		'FILES_FOLDER=/My Drive/hq',
		'API_BASE_URL=https://example.invalid/api',
		'EMPTY_VALUE=',
		"SINGLE_QUOTED='hello world'",
	].join('\n');
	const parsed = parseEnvValues(text);
	assert.equal(parsed.get('SOME_TOKEN'), 'tok_example_123');
	assert.equal(parsed.get('FILES_FOLDER'), '/My Drive/hq');
	assert.equal(parsed.get('API_BASE_URL'), 'https://example.invalid/api');
	assert.equal(parsed.get('EMPTY_VALUE'), '');
	assert.equal(parsed.get('SINGLE_QUOTED'), 'hello world');
});

test('a quoted value spans multiple lines intact; the next key still parses', () => {
	const parsed = parseEnvValues('MULTI="line one\nline two"\nNEXT=after\n');
	assert.equal(parsed.get('MULTI'), 'line one\nline two');
	assert.equal(parsed.get('NEXT'), 'after');
});
