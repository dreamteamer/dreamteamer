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

// `--workspace <name-or-path>` / `-w` — run the verb in ANOTHER workspace without leaving this one
// (`--vault <path>` is its pre-0.41.0 spelling, kept as a silent alias). Consumed HERE, before
// anything else resolves, because every verb downstream answers "which workspace am I in" from
// process.cwd(): changing the directory once IS the whole implementation, and it also points the
// dev-clone walk below at the TARGET's git_modules rather than the caller's.
//
// ⚠ It is spliced out of process.argv, not just out of the slice handed to run(): the dev-clone
// branch re-enters this same file, and a flag left in place would be applied a SECOND time — the
// path resolving against the already-changed directory, i.e. at the wrong workspace, silently.
//
// A PATH resolves against the INVOKING directory, which is where the caller typed it; every other
// relative path in the command then resolves against the target — the rule a `cd` would give. A NAME
// with no such directory is a record layer this workspace DECLARES (`dreamteamer.git_modules`), and
// resolves to `git_modules/<name>` — the precedent is `npm -w <name-or-path>`. The target is PINNED
// (DREAMTEAMER_WORKSPACE): a clone under git_modules/ is otherwise climbed out of by discovery, which
// would run the verb in the workspace AROUND it — a write landing in the reader and printing ✔.
const flagAt = process.argv.findIndex((a, i) => i >= 2 && (a === '--workspace' || a === '-w' || a === '--vault'));
if (flagAt !== -1) {
	const flag = process.argv[flagAt] === '--vault' ? '--vault' : '--workspace';
	const target = process.argv[flagAt + 1];
	if (!target || target.startsWith('-')) {
		console.error(flag === '--vault'
			? '\u2716 --vault needs a path to a workspace, e.g. `--vault ../another-workspace`'
			: '\u2716 --workspace needs a layer name or a path, e.g. `-w project-alpha` or `-w ../another-workspace`');
		process.exit(1);
	}
	let resolved = path.resolve(process.cwd(), target);
	if (!fs.existsSync(resolved)) {
		const here = findWorkspaceRoot(process.cwd());
		let declared = [];
		try { declared = Object.keys(JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).dreamteamer?.git_modules ?? {}); } catch { /* no workspace here */ }
		if (here && declared.includes(target) && !/[\\/]/.test(target)) {
			resolved = path.join(here, 'git_modules', target);
			if (!fs.existsSync(resolved)) {
				console.error(`\u2716 ${flag} ${target} \u2014 the layer is declared but not installed (${resolved}); run dreamteamer install`);
				process.exit(1);
			}
		} else {
			console.error(`\u2716 ${flag} ${target} \u2014 no such directory, and no layer of that name is declared here (declared: ${declared.join(', ') || 'none'})`);
			process.exit(1);
		}
	}
	process.chdir(resolved);
	process.env.DREAMTEAMER_WORKSPACE = process.cwd(); // the physical path, as discovery will see it
	process.argv.splice(flagAt, 2);
}

const devBin = findDevClone(process.cwd());
// `realpath`, NOT `path.resolve`: resolve is pure string math and does not follow symlinks, so a
// workspace whose git_modules/dreamteamer is a SYMLINK to the engine it is already running (the
// normal shape for a dev clone, and a common shape under a repos folder) compared two spellings
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
function findWorkspaceRoot(start) {
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
		if (workspace === process.env.DREAMTEAMER_WORKSPACE) break; // an explicitly targeted workspace is never climbed out of
		const viaModule = path.relative(higher, workspace).split(path.sep).some((seg) => MODULE_SEGMENTS.has(seg));
		if (!viaModule) break;
		workspace = higher;
	}
	return workspace;
}

function findDevClone(start) {
	const workspace = findWorkspaceRoot(start);
	if (!workspace) return null;
	const bin = path.join(workspace, 'git_modules', 'dreamteamer', 'bin', 'dreamteamer.js');
	return fs.existsSync(bin) ? bin : null;
}
