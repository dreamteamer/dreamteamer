#!/usr/bin/env node
// self-shadowing (decision 24, applied to the engine itself): when the workspace carries a
// git_modules/dreamteamer working clone, THAT engine runs — same npm-link semantics module
// content already gets. the npm-installed copy is bootstrap + fallback; the dev clone wins.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// path segments that mean "the thing below me is a module of the thing above me", never a
// workspace. Declared up here, not beside findDevClone: that call sits at module top level, so a
// `const` below it is still in its temporal dead zone when the walk needs it.
const MODULE_SEGMENTS = new Set(['node_modules', 'git_modules', 'modules']);

const self = fileURLToPath(import.meta.url);
const devBin = findDevClone(process.cwd());
// `realpath`, NOT `path.resolve`: resolve is pure string math and does not follow symlinks, so a
// workspace whose git_modules/dreamteamer is a SYMLINK to the engine it is already running (the
// normal shape for a dev clone, and what hq3 does elsewhere under projects/) compared two spellings
// of one file, decided they differed, and re-imported itself — a circular import that never
// settles, so the process exited silently having done nothing at all. Worse than a crash: every
// command "succeeded" with no output and no effect.
if (devBin && realpath(devBin) !== realpath(self)) {
	console.error(`… running the git_modules/dreamteamer dev clone (shadows the installed engine)`);
	await import(pathToFileURL(devBin).href);
} else {
	const { run } = await import('../src/cli.js');
	run(process.argv.slice(2));
}

/** Canonical on-disk identity of a path — symlinks followed, falling back to the literal path. */
function realpath(p) {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

// same workspace rule as src/workspace.js (nearest package.json with a `dreamteamer` key, climbing
// out only of module nesting), duplicated here because the dev clone must be found BEFORE choosing
// which src/ to load. Keep the two in step — they must never disagree about which workspace this is.
function findDevClone(start) {
	let dir = path.resolve(start);
	const candidates = []; // nearest → topmost
	while (true) {
		const p = path.join(dir, 'package.json');
		if (fs.existsSync(p)) {
			try {
				if ('dreamteamer' in JSON.parse(fs.readFileSync(p, 'utf8'))) candidates.push(dir);
			} catch { /* unparseable — keep walking */ }
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	if (!candidates.length) return null;
	let workspace = candidates[0];
	for (const higher of candidates.slice(1)) {
		const viaModule = path.relative(higher, workspace).split(path.sep).some((seg) => MODULE_SEGMENTS.has(seg));
		if (!viaModule) break;
		workspace = higher;
	}
	const bin = path.join(workspace, 'git_modules', 'dreamteamer', 'bin', 'dreamteamer.js');
	return fs.existsSync(bin) ? bin : null;
}
