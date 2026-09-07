// src/checkout.js — which checkout am I, and how does it become ready.
// WORKSPACE layer: knows git and the compiler, never the harness.
import path from 'node:path';
import fs, { realpathSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { staleness, compile, discoverModules } from './compile.js';
import { install as restoreGitModules } from './init.js';

export const defaultGit = (args, cwd) =>
	execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Git answers --git-common-dir as a REALPATH, so the two sides of the insideRoot test must be
// spelled the same way or a checkout reached through a symlink reads as outside its own primary
// (macOS /tmp → /private/tmp is the everyday case). A unit test's git is a fake and its paths need
// not exist, so a path that cannot be resolved on disk keeps the spelling it came with.
const real = (p) => { try { return realpathSync(p); } catch { return p; } };

/** Primary vs linked, derived from git — never configured. `primary` is the common dir's parent. */
export function describeCheckout(rootArg, git = defaultGit) {
	const root = path.resolve(rootArg);
	let gitDir, commonDir;
	try {
		gitDir = git(['rev-parse', '--git-dir'], root);
		commonDir = git(['rev-parse', '--git-common-dir'], root);
	} catch (e) {
		throw new Error(`${root} is not a git checkout — dreamteamer install needs one (${e.message.split('\n')[0]})`);
	}
	const abs = (p) => path.resolve(root, p);
	const linked = abs(gitDir) !== abs(commonDir);
	// The common dir's parent is the primary checkout whichever kind this is — and unlike `root` it
	// stays the primary when the caller hands us a SUBDIRECTORY of one.
	const primary = path.dirname(abs(commonDir));
	const rel = path.relative(real(primary), real(root));
	return { root, kind: linked ? 'linked' : 'primary', gitDir: abs(gitDir), commonDir: abs(commonDir), primary,
	         insideRoot: !rel.startsWith('..') && !path.isAbsolute(rel) };
}

/** The install plan as DATA: every step names what it found and what it would do, so the same
 * decisions are testable without a disk and printable without being run. Task 3 observes the state
 * and executes the steps; nothing here touches fs or git. */
export function planInstall(state, opts = {}) {
	const { checkout: c } = state;
	const steps = [];
	steps.push(state.hasEngine
		? { id: 'engine', label: 'engine: node_modules/dreamteamer present', state: 'already' }
		: { id: 'engine', label: 'engine: npm ci --prefer-offline (package-lock.json) or npm install', state: 'todo' });
	if (c.kind === 'primary') steps.push({ id: 'env', label: '.env: primary checkout — nothing to link', state: 'skip' });
	else if (state.hasEnv && !state.envIsLink) steps.push({ id: 'env', label: '.env: this worktree carries its own .env — left alone', state: 'already' });
	else if (state.hasEnv && state.envIsLink) steps.push({ id: 'env', label: '.env: linked to the primary', state: 'already' });
	else if (!state.primaryHasEnv) steps.push({ id: 'env', label: '.env: the primary has none — nothing to link', state: 'skip' });
	else if (!c.insideRoot && !opts.linkEnv) steps.push({ id: 'env', label: '.env: NOT linked', state: 'skip',
		why: 'this worktree lies outside the primary root — credentials are not linked there by default; pass --link-env to override for this run' });
	else steps.push({ id: 'env', label: `.env: link → ${c.primary}/.env`, state: 'todo' });
	for (const a of state.localAssets) {
		const id = `asset:${a.rel}`;
		if (a.presentHere && !a.isLinkHere) steps.push({ id, label: `${a.rel}: a real directory is here — left alone`, state: 'already' });
		else if (a.isLinkHere) steps.push({ id, label: `${a.rel}: linked`, state: 'already' });
		else if (c.kind === 'primary') steps.push({ id, label: `${a.rel}: primary checkout — nothing to link`, state: 'skip' });
		else if (!a.presentInPrimary) steps.push({ id, label: `${a.rel}: absent in the primary — skipped (the doctor reports the capability degraded)`, state: 'skip' });
		else steps.push({ id, label: `${a.rel}: link → ${c.primary}/${a.rel}`, state: 'todo' });
	}
	// gitModules carries the declared clones that are MISSING on this checkout, not every declared
	// one — the observer narrows it, which is what makes an empty array mean "nothing to restore"
	// rather than "none declared", and what lets a settled checkout plan with nothing todo.
	steps.push({ id: 'git-modules', label: state.gitModules.length ? `git modules: restore ${state.gitModules.join(', ')}` : 'git modules: nothing to restore', state: state.gitModules.length ? 'todo' : 'skip' });
	steps.push({ id: 'compile', label: state.stale ? 'compile: runtime missing or stale' : 'compile: fresh', state: state.stale ? 'todo' : 'already' });
	steps.push(state.postinstall
		? { id: 'postinstall', label: `postinstall: ${state.postinstall}`, state: 'todo' }
		: { id: 'postinstall', label: 'postinstall: none declared', state: 'skip' });
	return steps;
}

// ---- the impure half: observe this checkout, run the plan, print the board -----------------

// ⚠ BOTH OF THESE FOLLOW SYMLINKS, and that is the whole point. A DANGLING link is exactly what a
// moved or deleted primary leaves behind, and it is the one state where "there is a symlink here"
// and "this checkout has the file" disagree. Reading it as present would print `✔ linked to the
// primary` over a file that cannot be opened — the board lying about the one step nobody eyeballs.
// So: present means it RESOLVES, and a link counts as a link only when it resolves too.
const resolves = (p) => fs.existsSync(p);
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink() && fs.existsSync(p); } catch { return false; } };

/** Every declared local asset, workspace-level (root-relative) and module-level (module-relative),
 *  DEDUPED by rel with the first declaration winning: a step's id is `asset:<rel>`, so two modules
 *  declaring the same path would plan two steps under one id and the second would be dropped
 *  silently by any id-keyed read of the board. */
export function declaredLocalAssets(ws) {
	const seen = new Map(); // rel → {rel, module}
	const add = (raw, module) => {
		// ⚠ A REL MAY NOT CLIMB OUT OF THE WORKSPACE. `placeLink` writes wherever the rel points, so
		// `local-assets: ['../../x']` in a careless module declaration would drop a symlink beside
		// the workspace with nothing consulted. Refused when the plan is BUILT, so the board never
		// prints a step it must not run. (Task 4 teaches compile the same rule; a runtime that
		// writes outside the root should not wait for the compiler to be run.)
		const rel = path.normalize(raw);
		if (path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) {
			throw new Error(`local-assets: "${raw}"${module ? ` (declared by module ${module})` : ''} resolves outside the workspace root — a local asset must be a path INSIDE the workspace`);
		}
		if (!seen.has(rel)) seen.set(rel, { rel, module });
	};
	for (const rel of ws.pkg.dreamteamer?.['local-assets'] ?? []) add(rel, null);
	for (const m of discoverModules(ws.root, ws.pkg).modules) {
		let mp = {};
		try { mp = JSON.parse(fs.readFileSync(path.join(m.root, 'package.json'), 'utf8')); } catch { /* no package.json */ }
		for (const rel of mp.dreamteamer?.['local-assets'] ?? []) add(path.relative(ws.root, path.join(m.root, rel)), m.name);
	}
	return [...seen.values()];
}

/** What is true of this checkout right now — the only function here that reads the disk, so
 *  `planInstall` stays pure and the whole board is decidable from this one object. */
export function observeState(ws) {
	const checkout = describeCheckout(ws.root);
	const here = (rel) => path.join(ws.root, rel), there = (rel) => path.join(checkout.primary, rel);
	const s = staleness(ws.root);
	return {
		checkout,
		hasEngine: resolves(here('node_modules/dreamteamer')),
		hasEnv: resolves(here('.env')), envIsLink: isLink(here('.env')), primaryHasEnv: resolves(there('.env')),
		localAssets: declaredLocalAssets(ws).map((a) => ({ ...a, presentHere: resolves(here(a.rel)), isLinkHere: isLink(here(a.rel)), presentInPrimary: resolves(there(a.rel)) })),
		// ⚠ THE MISSING clones, not every declared one. A settled worktree would otherwise print
		// `▶ git modules: restore <names>` for ever, and this is the step whose result nobody looks
		// at — so the narrowing here is what makes the empty case mean "nothing to restore".
		gitModules: Object.keys(ws.pkg.dreamteamer?.['git-modules'] ?? {}).filter((n) => !resolves(here(path.join('git_modules', n)))),
		stale: !s.compiled || s.stale.length > 0,
		postinstall: ws.pkg.dreamteamer?.postinstall ?? null,
	};
}

/** Place a symlink, replacing a dangling one. A step only reaches here because the observer read
 *  the path as absent, which a broken link is — so the leftover has to be cleared, never trusted. */
function placeLink(target, at) {
	fs.mkdirSync(path.dirname(at), { recursive: true });
	try { if (fs.lstatSync(at).isSymbolicLink()) fs.unlinkSync(at); } catch { /* nothing there */ }
	fs.symlinkSync(target, at);
	return 0;
}

/** ⚠ EVERY EXECUTOR ANSWERS WITH A CODE, NEVER A THROW. The board's contract is that one failure
 *  names itself and the remaining steps still run — and under `--json` a throw out of here would
 *  abandon the payload as well as the rest of the plan. `compile` throws on a source error, and fs
 *  throws on everything from EACCES to a primary that vanished mid-run, so the guard is the rule
 *  here rather than the exception. */
const guard = (name, fn) => (...a) => {
	try { return fn(...a) ?? 0; } catch (e) { console.error(`✖ ${name}: ${e.message.split('\n')[0]}`); return 1; }
};

// One executor per step id, keyed by the id's kind. None decides ANYTHING — whether a step runs at
// all was settled by `planInstall`. `stdio` is the caller's, so a `--json` run can send a
// subprocess's chatter to stderr and keep stdout for the payload.
const RUN = {
	engine: guard('engine', (ws, st, rel, stdio) => spawnSync('npm', [fs.existsSync(path.join(ws.root, 'package-lock.json')) ? 'ci' : 'install', '--prefer-offline', '--no-audit', '--no-fund'], { cwd: ws.root, stdio }).status ?? 1),
	env: guard('.env', (ws, st) => placeLink(path.join(st.checkout.primary, '.env'), path.join(ws.root, '.env'))),
	asset: guard('asset', (ws, st, rel) => placeLink(path.join(st.checkout.primary, rel), path.join(ws.root, rel))),
	'git-modules': guard('git modules', (ws) => restoreGitModules(ws)),
	compile: guard('compile', (ws) => compile(ws)),
	postinstall: guard('postinstall', (ws, st, rel, stdio) => spawnSync(st.postinstall, { cwd: ws.root, shell: true, stdio, env: { ...process.env, DT_PRIMARY: st.checkout.primary } }).status ?? 1),
};

/** Print the board and run the todo steps in order. `dryRun` prints and runs nothing. Returns 1 if
 *  any step errored — one failure never abandons the rest, because a checkout half-made-ready with
 *  a named failure is more useful than one that stopped at the first thing it could not do. */
export function applyInstall(ws, state, steps, { dryRun = false, log = console.log, stdio = 'inherit' } = {}) {
	let failed = 0;
	for (const s of steps) {
		const glyph = s.state === 'todo' ? '▶' : s.state === 'already' ? '✔' : '—';
		log(`${glyph} ${s.label}${s.why ? `\n    ${s.why}` : ''}`);
		if (s.state !== 'todo' || dryRun) continue;
		const [kind, rel] = s.id.split(/:(.+)/);
		const code = RUN[kind](ws, state, rel, stdio);
		if (code !== 0) { failed++; log(`✖ ${s.id} failed (exit ${code})`); }
	}
	return failed ? 1 : 0;
}

/** `dt install` on THIS checkout.
 *
 *  ⚠ `--json` IS NOT A DRY RUN: it applies the plan and then reports it as data. Which means the
 *  run that most needs to be parseable — the FIRST install in a fresh worktree — is also the one
 *  with the most to say: `compile` logs its summary through console.log, and the shelled-out steps
 *  write to whatever handles they inherit. So under `--json` stdout carries the payload and
 *  NOTHING else: the board goes to stderr (a human watching a piped run still wants it),
 *  console.log is pointed at stderr for the duration, and each subprocess is handed stderr for its
 *  own stdout. A `--json` that only parses on an already-settled checkout is not an interface. */
export function installCommand(ws, rest) {
	const flags = new Set(rest.filter((a) => a.startsWith('--')));
	const json = flags.has('--json');
	const state = observeState(ws);
	const steps = planInstall(state, { linkEnv: flags.has('--link-env') });
	const board = [];
	const log = (l) => { board.push(l); (json ? console.error : console.log)(l); };
	log(state.checkout.kind === 'linked'
		? `linked worktree of ${state.checkout.primary}${state.checkout.insideRoot ? '' : ' (outside its root)'}`
		: 'primary checkout');
	const stdout = console.log;
	if (json) console.log = console.error; // compile() and the git-modules restore report through it
	let code;
	try {
		code = applyInstall(ws, state, steps, { dryRun: flags.has('--dry-run'), log, stdio: json ? ['ignore', 2, 2] : 'inherit' });
	} finally {
		console.log = stdout;
	}
	if (json) { console.log(JSON.stringify({ checkout: state.checkout, steps, log: board, code }, null, 2)); return code; }
	if (state.checkout.kind === 'linked') log(`\nbefore you finish here: dt commit your records. Landing (dt land worktrees/${path.basename(ws.root)}) ships in slice 4 — until then the primary merges branch ${'worktree-' + path.basename(ws.root)} by hand.`);
	return code;
}
