// Tier 2 — the operator's hand-written rules reach EVERY harness, not only CLAUDE.md.
//
// Measured 2026-09-07 in the Omnigent codex trial: AGENTS.md and GEMINI.md are emitted as the
// generated block ALONE, so a Codex session never sees the rules and will `git add -A`. One source,
// rendered verbatim into each file, is the fix — and it must be a COMPILE SOURCE, or `dt status`
// never reports the workspace stale when it is edited and every harness file silently lags.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, readFile, compileQuietly } from '../helpers/ws.js';
import { staleness } from '../../src/compile.js';

const RULES = '## house rules\n\n1. Never `git add -A`.\n2. Quote a result from the running system.\n';

function withInstructions(text = RULES) {
	const ws = workspace();
	fs.writeFileSync(path.join(ws.root, 'dreamteamer.md'), text);
	compileQuietly(ws.ws);
	return ws;
}

describe('dreamteamer.md is a compile source', () => {
	test('editing it makes the workspace stale', () => {
		const ws = withInstructions();
		assert.equal(staleness(ws.root).stale.length, 0, 'clean right after a compile');
		fs.writeFileSync(path.join(ws.root, 'dreamteamer.md'), RULES + '\n3. A third rule.\n');
		const s = staleness(ws.root);
		assert.ok(s.stale.some((x) => x.includes('dreamteamer.md')), `edit must be seen — got ${JSON.stringify(s.stale)}`);
	});

	test('a workspace without one compiles clean and reports nothing new', () => {
		const ws = workspace();
		assert.equal(staleness(ws.root).stale.length, 0);
		assert.equal(readFile(ws.root, 'dreamteamer.md'), null);
	});
});
