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

describe('the instructions block reaches every harness', () => {
	const HARNESSES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'];
	const between = (text) => /<!-- dreamteamer:instructions:begin -->\n([\s\S]*?)\n<!-- dreamteamer:instructions:end -->/.exec(text)?.[1];

	test('all three carry byte-identical rule text', () => {
		const ws = withInstructions();
		const bodies = HARNESSES.map((f) => between(readFile(ws.root, f) ?? ''));
		for (const [i, b] of bodies.entries()) assert.ok(b, `${HARNESSES[i]} has no instructions block`);
		assert.equal(new Set(bodies).size, 1, 'every harness must carry the SAME text');
		assert.equal(bodies[0].trim(), RULES.trim(), 'and it must be the source, verbatim');
	});

	test('it sits ABOVE the orientation block', () => {
		const ws = withInstructions();
		for (const f of HARNESSES) {
			const text = readFile(ws.root, f);
			// ⚠ ASSERT PRESENCE FIRST. `indexOf` answers -1 for a string that is not there, so the
			// ordering comparison alone passes loudest when NOTHING was rendered at all.
			const at = text.indexOf('<!-- dreamteamer:instructions:begin -->');
			const orientation = text.indexOf('<!-- dreamteamer:begin');
			assert.ok(at >= 0, `${f} has no instructions block`);
			assert.ok(orientation >= 0, `${f} has no orientation block`);
			assert.ok(at < orientation, `${f}: instructions must precede the orientation block`);
		}
	});

	test('the cursor rule carries it in the BODY, under its frontmatter', () => {
		const ws = withInstructions();
		const mdc = readFile(ws.root, '.cursor/rules/dreamteamer.mdc');
		assert.ok(mdc, 'the cursor rule must exist');
		const fmEnd = mdc.indexOf('---', 3) + 3;
		assert.ok(mdc.indexOf('<!-- dreamteamer:instructions:begin -->') > fmEnd,
			'the block must be in the body, never inside the frontmatter');
		assert.equal(between(mdc).trim(), RULES.trim());
	});

	test('NOTEBOOKLM.md is deliberately excluded', () => {
		const ws = withInstructions();
		const nb = readFile(ws.root, 'NOTEBOOKLM.md');
		// Not `if (nb)`: the fixture enables every known harness, so an absent file would silently
		// turn the one assertion this test exists for into a no-op.
		assert.ok(nb, 'the fixture enables notebooklm, so the file must exist');
		assert.match(nb, /dreamteamer:begin/, 'and it must carry its own managed block');
		assert.doesNotMatch(nb, /dreamteamer:instructions:begin/, 'a notebook config is not agent instructions');
	});

	test('removing the source removes the block from every file', () => {
		const ws = withInstructions();
		// The block has to BE there before its removal can mean anything.
		for (const f of HARNESSES) assert.match(readFile(ws.root, f) ?? '', /dreamteamer:instructions:begin/, `${f} never had a block to remove`);
		fs.rmSync(path.join(ws.root, 'dreamteamer.md'));
		compileQuietly(ws.ws);
		for (const f of HARNESSES) {
			assert.doesNotMatch(readFile(ws.root, f) ?? '', /dreamteamer:instructions/, `${f} kept a stale block`);
		}
	});
});

// ⚠ VERBATIM HAS TO SURVIVE `$`. `String.prototype.replace` with a STRING replacement interprets
// `$&`, `` $` ``, `$'` and `$1` inside it — so prose carrying any of them is silently rewritten as
// it is inserted, and `$'…'` is ordinary bash (ANSI-C quoting) in a file about shell commands.
// Measured: `use $'\n'` came out as `use ` + the whole text before the match.
describe('the rules are rendered byte-for-byte', () => {
	const DOLLARS = "## house rules\n\n1. Write a newline as $'\\n', never a literal one.\n2. `$&`, $`x` and $1 are prose here, not patterns.\n";

	test('a `$` in the source survives insertion AND the next compile', () => {
		const ws = withInstructions(DOLLARS);
		const body = (f) => /<!-- dreamteamer:instructions:begin -->\n([\s\S]*?)\n<!-- dreamteamer:instructions:end -->/.exec(readFile(ws.root, f) ?? '')?.[1];
		for (const f of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.cursor/rules/dreamteamer.mdc']) {
			assert.equal(body(f), DOLLARS.trimEnd(), `${f}: inserted text is not the source`);
		}
		// The second compile takes the REPLACE-IN-PLACE branch, which is a different call site.
		compileQuietly(ws.ws);
		for (const f of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.cursor/rules/dreamteamer.mdc']) {
			assert.equal(body(f), DOLLARS.trimEnd(), `${f}: rewritten text is not the source`);
		}
	});
});
