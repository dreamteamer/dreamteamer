// Tier 2 — the root harness files: generated block first, the operator's DREAMTEAMER.md after it,
// system collections (the schema of schemas first) before any module, and the files gitignored.
// "As an agent reading CLAUDE.md cold, I meet the schema of schemas before any domain, and the
// operator's rules after the facts they qualify." Invented names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, writeCollection, compileError, compileQuietly, git } from '../helpers/ws.js';
import { BEGIN, END, INSTRUCTIONS_BEGIN } from '../../src/harnesses.js';

const NOTE = { description: 'A note.', ids: { from: '{{ title | slug }}' }, fields: { title: { type: 'string', required: true }, body: { type: 'markdown', body: true } } };

test('a workspace still carrying dreamteamer.md is refused with the rename', () => {
	const w = workspace({ compile: false });
	fs.writeFileSync(path.join(w.root, 'dreamteamer.md'), 'Rule one.\n');
	assert.match(compileError(w.ws), /dreamteamer\.md is named DREAMTEAMER\.md now — rename it/);
});

test('CLAUDE.md opens with the generated block; the operator text comes only after it', () => {
	const w = workspace({ compile: false });
	writeCollection(w.root, 'notes', NOTE);
	fs.writeFileSync(path.join(w.root, 'DREAMTEAMER.md'), 'OPERATOR RULE: always measure.\n');
	assert.equal(compileError(w.ws), null);
	const text = fs.readFileSync(path.join(w.root, 'CLAUDE.md'), 'utf8');
	assert.equal(text.split('\n').find((l) => l.trim()), BEGIN);
	const end = text.indexOf(END);
	assert.ok(text.indexOf('OPERATOR RULE') > end, 'the rule follows the end marker');
	assert.ok(text.indexOf(INSTRUCTIONS_BEGIN) > end);
	assert.equal(text.slice(0, end).includes('OPERATOR RULE'), false);
});

test('inside the block, collections comes first, then the other system collections, then the modules', () => {
	const w = workspace({ compile: false });
	writeCollection(w.root, 'notes', NOTE);
	compileQuietly(w.ws);
	const block = fs.readFileSync(path.join(w.root, 'CLAUDE.md'), 'utf8').split(END)[0];
	const lines = block.split('\n');
	const firstItem = lines.findIndex((l) => /^- [a-z]/.test(l));
	assert.match(lines[firstItem], /^- collections — /);
	const sysHead = lines.findIndex((l) => l.startsWith('**System collections**'));
	const firstModule = lines.findIndex((l, i) => i > sysHead && /^\*\*/.test(l));
	assert.ok(sysHead >= 0 && sysHead < firstItem);
	const systemItems = lines.slice(firstItem, firstModule).filter((l) => l.startsWith('- ')).map((l) => l.slice(2).split(' — ')[0]);
	for (const k of ['collections', 'skills', 'agents', 'commands', 'mixins', 'modules', 'repos']) assert.ok(systemItems.includes(k), `${k} is listed with the system collections`);
	assert.ok(lines.slice(firstModule).some((l) => /^- notes — /.test(l)), 'the workspace module follows');
});

test('the root harness files are gitignored: init writes the lines, and compile leaves none for git', () => {
	const w = workspace({ compile: false });
	const ignore = fs.readFileSync(path.join(w.root, '.gitignore'), 'utf8').split('\n');
	for (const f of ['/CLAUDE.md', '/AGENTS.md', '/GEMINI.md', '/NOTEBOOKLM.md']) assert.ok(ignore.includes(f), f);
	compileQuietly(w.ws);
	const status = git(w.root, ['status', '--porcelain']);
	assert.doesNotMatch(status, /CLAUDE\.md|AGENTS\.md|GEMINI\.md/);
});

test('compile adds the lines to an existing workspace that lacks them', () => {
	const w = workspace({ compile: false });
	const gi = path.join(w.root, '.gitignore');
	fs.writeFileSync(gi, fs.readFileSync(gi, 'utf8').split('\n').filter((l) => !/^\/(CLAUDE|AGENTS|GEMINI|NOTEBOOKLM)\.md$/.test(l)).join('\n'));
	const out = compileQuietly(w.ws);
	assert.ok(out.stdout.some((l) => /\.gitignore now ignores \/CLAUDE\.md/.test(l)));
	assert.ok(fs.readFileSync(gi, 'utf8').split('\n').includes('/CLAUDE.md'));
});
