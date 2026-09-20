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
import { workspace, readFile, compileQuietly, compileError } from '../helpers/ws.js';
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

	// ⚠ CREATING it is the moment that matters, and it was the one the scan missed. The manifest-source
	// walk sees every later EDIT because the file is a source by then; on day one it is not, and the
	// new-source scan walks only KINDS directories. Measured before the fix: `stale: []` on a workspace
	// whose harness files carried no instructions block at all.
	test('CREATING it is reported as a new, uncompiled source', () => {
		const ws = workspace();
		assert.equal(staleness(ws.root).stale.length, 0, 'clean right after a compile');
		fs.writeFileSync(path.join(ws.root, 'dreamteamer.md'), RULES);
		assert.deepEqual(staleness(ws.root).stale, ['dreamteamer.md (new, uncompiled)']);
		compileQuietly(ws.ws);
		assert.equal(staleness(ws.root).stale.length, 0, 'and compiling clears it');
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


// ⚠ THE MOST NATURAL RULE TO WRITE IN A FILE ABOUT AGENT BEHAVIOUR IS A RULE ABOUT THE GENERATED
// BLOCK — and `writeBlock` finds its block by the FIRST occurrence of its begin marker anywhere in
// the file, so a marker quoted inside the verbatim text is found before the real delimiter. Both
// manifestations were measured on this fixture, and both are silent: `compile` exits 0 either way.
describe('a managed marker in the source is refused', () => {
	const compiledWith = (text) => {
		const ws = workspace();
		fs.writeFileSync(path.join(ws.root, 'dreamteamer.md'), text);
		return { ws, err: compileError(ws.ws) };
	};

	// Before the guard: the orientation pass rewrote the QUOTED region and the instructions pass
	// restored it from source, so the real orientation block was never written again. Measured — a
	// collection added after that first compile never appeared in CLAUDE.md, while its runtime
	// descriptor was written and `status` reported the runtime fresh.
	test('quoting the orientation markers fails, naming the marker and the line', () => {
		const { err } = compiledWith(`## house rules\n\n1. Never edit inside ${'<!-- dreamteamer:begin (generated — do not edit inside this block) -->'}.\n`);
		assert.ok(err, 'compile must refuse');
		assert.match(err, /dreamteamer\.md:3:/, 'the offending line must be named');
		assert.match(err, /dreamteamer:begin/, 'and the marker it found');
		assert.match(err, /Describe the block instead of quoting its marker/);
	});

	test('quoting the orientation END marker fails too', () => {
		const { err } = compiledWith(`1. A rule.\n2. The block closes with ${'<!-- dreamteamer:end -->'}.\n`);
		assert.ok(err, 'compile must refuse');
		assert.match(err, /dreamteamer\.md:2:/);
	});

	// Before the guard: the block was closed at the quoted copy and a SECOND end line appended, so
	// every compile of an unchanged workspace added ~40 bytes and one duplicated line to three
	// committed files, forever — six compiles took CLAUDE.md from 3095 to 3290 bytes.
	test('quoting the instructions end marker fails, naming the marker and the line', () => {
		const { err } = compiledWith(`## house rules\n\n1. A rule.\n2. It ends at ${'<!-- dreamteamer:instructions:end -->'}.\n`);
		assert.ok(err, 'compile must refuse');
		assert.match(err, /dreamteamer\.md:4:/);
		assert.match(err, /dreamteamer:instructions:end/);
	});

	test('quoting the instructions BEGIN marker fails too', () => {
		const { err } = compiledWith(`1. It opens at ${'<!-- dreamteamer:instructions:begin -->'}.\n`);
		assert.ok(err, 'compile must refuse');
		assert.match(err, /dreamteamer\.md:1:/);
	});

	// ⚠ THE GUARD MUST NOT BE OVER-BROAD. Writing a rule ABOUT the generated block is the whole point
	// of the file, and only the LITERAL marker text is a problem — prose that describes it is not.
	test('prose that merely mentions the block compiles, and the block is stable across compiles', () => {
		const prose = '## house rules\n\n1. Never edit inside the generated dreamteamer block.\n2. `dreamteamer:begin` marks where it starts.\n';
		const ws = workspace();
		fs.writeFileSync(path.join(ws.root, 'dreamteamer.md'), prose);
		assert.equal(compileError(ws.ws), null, 'describing the block must be allowed');
		const first = readFile(ws.root, 'CLAUDE.md');
		assert.match(first, /Never edit inside the generated dreamteamer block/);
		// The growth in the second manifestation showed up as a file that never reached a fixed point.
		compileQuietly(ws.ws);
		assert.equal(readFile(ws.root, 'CLAUDE.md'), first, 'a second compile of an unchanged workspace must be a no-op');
	});
});

// `.trimEnd()` on a whitespace-only source yields `''` — not nullish, so `?? null` let it through and
// the three Markdown files got an empty BEGIN/END pair while the cursor rule omitted the part.
describe('an empty source renders no block anywhere', () => {
	test('a whitespace-only dreamteamer.md is treated as no instructions at all', () => {
		const ws = workspace();
		fs.writeFileSync(path.join(ws.root, 'dreamteamer.md'), '   \n\n\t\n');
		compileQuietly(ws.ws);
		for (const f of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.cursor/rules/dreamteamer.mdc']) {
			assert.doesNotMatch(readFile(ws.root, f) ?? '', /dreamteamer:instructions/, `${f} carries an empty block`);
		}
	});
});
