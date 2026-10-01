// Which tier-2 files a working-tree change should run — the selection behind `npm run verify:fast`.
//
// Pure: it takes the changed paths and the test files' sources and returns a decision, so the rule is
// testable without git (test/unit/test-select.test.js). The git glue lives in scripts/test.mjs.
//
// WHY A HEURISTIC AND NOT AN IMPORT GRAPH: every tier-2 file drives the real CLI binary, and the CLI
// imports all of src/ — an import graph would select every file for every change, which is the full
// run this exists to avoid. So a file is chosen by NAME (src/store.js → relations-store, store-index)
// or by MENTION (a test that imports or names the changed file). That is a guess about relevance,
// which is why this tier is never the gate: `npm run verify` runs everything, once, before a commit.
import { basename } from 'node:path';

// Run when a change names no test at all, so a fast run never silently runs only tier 1 after a src/
// edit. compile and records are the two files that cross the most of the engine per second.
export const SMOKE = ['test/integration/compile.test.js', 'test/integration/records.test.js'];

const stem = (p) => basename(p).replace(/\.d\.ts$|\.test\.js$|\.[a-z]+$/, '');

// Root files every fixture workspace ALSO has. A test naming `package.json` means the fixture's,
// so a mention says nothing about the engine's own copy — measured: these two names alone pulled 20
// of 61 files into one fast run. The engine's package.json still matters (deps, `files`), so a change
// to it runs the smoke pair; the prose ones run nothing beyond tier 1.
const FIXTURE_NAMES = new Set(['package.json', 'package-lock.json', 'CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'README.md', '.gitignore']);

/**
 * @param {object} o
 * @param {string[]} o.changed       repo-relative paths that differ from HEAD (tracked or untracked)
 * @param {Map<string,string>} o.integration  repo-relative tier-2 file → its source text
 * @param {string[]} [o.failed]      files that failed on their last run
 * @returns {{ files: string[], all: boolean, reasons: Map<string,string>, unmatched: string[] }}
 */
export function selectTests({ changed, integration, failed = [] }) {
	const reasons = new Map();
	const unmatched = [];
	const pick = (file, why) => { if (!reasons.has(file)) reasons.set(file, why); };
	const names = [...integration.keys()];

	for (const f of failed) if (integration.has(f)) pick(f, 'failed last run');

	for (const p of changed) {
		// The shared fixture builder decides what every tier-2 file sees.
		if (p.startsWith('test/helpers/')) return { files: names, all: true, reasons: new Map(names.map((n) => [n, p])), unmatched };
		if (p.startsWith('test/unit/') || p.startsWith('test/perf/') || p.startsWith('test/.')) continue; // tier 1 always runs
		if (integration.has(p)) { pick(p, 'changed'); continue; }

		if (FIXTURE_NAMES.has(p)) { if (p.startsWith('package')) unmatched.push(p); continue; }
		const s = stem(p);
		const base = basename(p);
		let hit = false;
		for (const [file, src] of integration) {
			// "store" names relations-store and store-index; "namespace" names namespaces-by-module.
			const byName = p.startsWith('src/') && s.length > 2 && stem(file).split('-').some((w) => w === s || w === `${s}s` || w.startsWith(`${s}-`)) || stem(file) === s;
			const byMention = src.includes(`/${base}'`) || src.includes(`'${base}'`) || src.includes(`/${base}"`) || src.includes(`"${base}"`) || src.includes(`/${base}\``);
			if (byName || byMention) { pick(file, `${byName ? 'named' : 'mentions'} ${p}`); hit = true; }
		}
		if (!hit && (p.startsWith('src/') || p.startsWith('bin/') || p.startsWith('collections/'))) unmatched.push(p);
	}

	if (unmatched.length) for (const f of SMOKE) if (integration.has(f)) pick(f, `smoke: nothing names ${unmatched.join(', ')}`);
	return { files: [...reasons.keys()].sort(), all: false, reasons, unmatched };
}
