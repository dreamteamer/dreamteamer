// src/checkout.js — which checkout am I, and how does it become ready.
// WORKSPACE layer: knows git and the compiler, never the harness.
import path from 'node:path';
import fs, { realpathSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { staleness, compile, discoverModules } from './compile.js';
import { init, initFootprint, seedBlock, install as restoreGitModules, offRef } from './init.js';
import { declaredGitModules } from './workspace.js';
import { engineVersion, readManifest, RUNTIME_DIR } from './runtime.js';
import { satisfies } from './semver.js';

export const defaultGit = (args, cwd) => {
	try {
		return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	} catch (e) {
		// ⚠ GIT'S REASON LEADS. execFileSync does append the child's stderr to its message, but
		// BEHIND `Command failed: git <argv>` — and every summary in this file reads
		// `message.split('\n')[0]` (describeCheckout's parenthetical, applyInstall's per-step ✖), so
		// the one line that survived was the command line and never the explanation. `dt rm` on a
		// LOCKED worktree led with the argv and mentioned the lock underneath it.
		const why = String(e.stderr ?? '').trim().split('\n').filter(Boolean);
		if (why.length) e.message = [...why, `(git ${args.join(' ')})`].join('\n  ');
		throw e;
	}
};

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
	// ⚠ EVERY declared direct dependency, not just the engine. A worktree whose engine is a mirrored dev
	// LINK used to read as ready while an installed extension was missing — so
	// npm never ran, and compile then refused the extension's source folder as an unknown kind.
	const missing = state.missingDeps ?? [];
	steps.push(missing.length
		? { id: 'dependencies', label: `dependencies: ${missing.join(', ')} missing — npm ci --prefer-offline (package-lock.json) or npm install; a linked one is kept`, state: 'todo' }
		: { id: 'dependencies', label: 'dependencies: every declared package present', state: 'already' });
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
	// gitModules carries the declared clones that are MISSING on this checkout or off their declared
	// ref, not every declared one — the observer narrows it, which is what makes an empty array mean "nothing to restore"
	// rather than "none declared", and what lets a settled checkout plan with nothing todo.
	steps.push({ id: 'git_modules', label: state.gitModules.length ? `git modules: restore or re-point ${state.gitModules.join(', ')}` : 'git modules: nothing to restore', state: state.gitModules.length ? 'todo' : 'skip' });
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
		// `local_assets: ['../../x']` in a careless module declaration would drop a symlink beside
		// the workspace with nothing consulted. Refused when the plan is BUILT, so the board never
		// prints a step it must not run. (Task 4 teaches compile the same rule; a runtime that
		// writes outside the root should not wait for the compiler to be run.)
		const rel = path.normalize(raw);
		if (path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) {
			throw new Error(`local_assets: "${raw}"${module ? ` (declared by module ${module})` : ''} resolves outside the workspace root — a local asset must be a path INSIDE the workspace`);
		}
		if (!seen.has(rel)) seen.set(rel, { rel, module });
	};
	for (const rel of ws.pkg.dreamteamer?.local_assets ?? []) add(rel, null);
	for (const m of discoverModules(ws.root, ws.pkg).modules) {
		let mp = {};
		try { mp = JSON.parse(fs.readFileSync(path.join(m.root, 'package.json'), 'utf8')); } catch { /* no package.json */ }
		for (const rel of mp.dreamteamer?.local_assets ?? []) add(path.relative(ws.root, path.join(m.root, rel)), m.name);
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
		missingDeps: declaredDeps(ws).filter((d) => !resolves(here(path.join('node_modules', d)))),
		hasEnv: resolves(here('.env')), envIsLink: isLink(here('.env')), primaryHasEnv: resolves(there('.env')),
		localAssets: declaredLocalAssets(ws).map((a) => ({ ...a, presentHere: resolves(here(a.rel)), isLinkHere: isLink(here(a.rel)), presentInPrimary: resolves(there(a.rel)) })),
		// ⚠ THE MISSING clones and the ones off their declared ref, not every declared one. A settled
		// worktree would otherwise print `▶ git modules: …` for ever, and this is the step whose result
		// nobody looks at — so the narrowing here is what makes the empty case mean "nothing to do".
		// … and the ones a clone on disk NEEDS (`declaredGitModules`): missing, off their ref, nothing yet under
		// a declarer (a clone of its own there is satisfied), or a nested copy missing or off its ref. Before
		// the first install only this workspace's own are visible.
		gitModules: [...new Set([
			...[...declaredGitModules(ws.pkg, ws.root).map].filter(([n, m]) => !resolves(here(path.join('git_modules', n))) || offRef(here(path.join('git_modules', n)), m.ref) || m.declarers.some((by) => by && !resolves(here(path.join(by, 'git_modules', n))))).map(([n]) => n),
			// a nested copy that is still a LINK (laid while the declarer agreed with the top) is work to do
			...declaredGitModules(ws.pkg, ws.root).nested.filter((c) => isLink(here(path.join(c.by, 'git_modules', c.name))) || !resolves(here(path.join(c.by, 'git_modules', c.name))) || offRef(here(path.join(c.by, 'git_modules', c.name)), c.ref)).map((c) => c.name),
		])],
		stale: !s.compiled || s.stale.length > 0,
		postinstall: ws.pkg.dreamteamer?.postinstall ?? null,
	};
}

/** Every top-level package in node_modules that is a SYMLINK (scoped ones included), as
 *  `[path, raw link target]` — declared or not: the engine a checkout was cut to test is often an
 *  undeclared link, and it is exactly the one npm's pruning would delete. */
function linkedPackages(root) {
	const nm = path.join(root, 'node_modules');
	const out = [];
	const scan = (dir) => {
		let names = [];
		try { names = fs.readdirSync(dir); } catch { return; }
		for (const n of names) {
			if (n.startsWith('.')) continue;
			const p = path.join(dir, n);
			let st;
			try { st = fs.lstatSync(p); } catch { continue; }
			if (st.isSymbolicLink()) out.push([p, fs.readlinkSync(p)]);
			else if (n.startsWith('@') && dir === nm && st.isDirectory()) scan(p);
		}
	};
	scan(nm);
	return out;
}

/** The workspace's direct dependencies, sorted — what `npm install` is responsible for. */
const declaredDeps = (ws) => Object.keys({ ...ws.pkg?.dependencies, ...ws.pkg?.devDependencies }).sort();

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

/** npm, resolved BESIDE the running node first and on PATH second.
 *
 *  ⚠ THE ORDER IS THE MEASUREMENT (spec §15). A hook runs under `sh`, which reads no startup file,
 *  so PATH may carry nothing at all — while `process.execPath` is an absolute path to the node that
 *  is running this line, and every installer that ships node ships npm beside it. Trusting PATH
 *  first would pick a stale global npm on a machine that has both, and find nothing on a machine
 *  reached through the shim. Returns null when neither resolves, which is a board line, not a throw.
 */
export function resolveNpm(execPath = process.execPath, env = process.env) {
	const bin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
	// ⚠ EXECUTABLE, not merely present. `resolves` is `existsSync`, which is true of a DIRECTORY
	// called `npm` and of a file nobody may run — and this path is then spawned, so the difference
	// between "it is there" and "it can be executed" is the difference between a named board line
	// and an EACCES nobody planned for. A proof runner's `requires: { bin: … }` learned the same.
	const runnable = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };
	const beside = path.join(path.dirname(execPath), bin);
	if (runnable(beside)) return beside;
	for (const dir of (env.PATH ?? '').split(path.delimiter)) {
		if (dir && runnable(path.join(dir, bin))) return path.join(dir, bin);
	}
	return null;
}

/** The environment a shelled-out step gets: this process's, plus the directory of the node that is
 *  running it, at the FRONT of PATH.
 *
 *  ⚠ MEASURED, and it is the other half of `resolveNpm`. Resolving npm absolutely is not enough:
 *  npm's own shebang is `#!/usr/bin/env node`, so under a hook's environment
 *  (`env -i PATH=/usr/bin:/bin`) the resolved npm was found, spawned, and died at exit 127 with
 *  `env: node: No such file or directory` — the interpreter lookup, one level below the one the
 *  shim fixes. A declared `postinstall` has exactly the same problem for exactly the same reason,
 *  so both steps are handed the same environment. */
export const childEnv = () => ({ ...process.env, PATH: [path.dirname(process.execPath), process.env.PATH ?? ''].filter(Boolean).join(path.delimiter) });

// One executor per step id, keyed by the id's kind. None decides ANYTHING — whether a step runs at
// all was settled by `planInstall`. `stdio` is the caller's, so a `--json` run can send a
// subprocess's chatter to stderr and keep stdout for the payload.
const RUN = {
	// ⚠ `npm` ARRIVES AS AN ARGUMENT rather than being resolved here, and that is what makes the
	// refusal below testable at all: with the resolution inlined, deleting the guard left the suite
	// green, because no fixture can make npm unresolvable beside the node running the test.
	dependencies: guard('dependencies', (ws, st, rel, stdio, npm) => {
		// ⚠ THE HONEST BOARD LINE, not a crash. `npm` is missing far more often than `node` is —
		// a hook's `sh` finds neither, and the shim resolves only node — so the step has to say
		// WHICH of the two it could not find. `✖ dependencies:` is prepended by the guard.
		if (!npm) throw new Error('cannot install — node found, npm not on PATH');
		// ⚠ A DELIBERATE DEVELOPMENT LINK SURVIVES. `npm ci` deletes node_modules and `npm install`
		// re-points a linked package at the registry, so a dev engine (or a linked extension) would be
		// silently replaced by the published copy — a checkout running a different engine than the one
		// it was cut to test. Every linked direct dependency is recorded here and put back after npm.
		// ⚠ WORKING links only. A DANGLING one (a moved checkout, a deleted vendor folder) is exactly the
		// broken entry this step exists to repair — restoring it undid npm's repair and failed the install.
		const links = linkedPackages(ws.root).filter(([p]) => resolves(p));
		const status = spawnSync(npm, [fs.existsSync(path.join(ws.root, 'package-lock.json')) ? 'ci' : 'install', '--prefer-offline', '--no-audit', '--no-fund'], { cwd: ws.root, stdio, env: childEnv(), timeout: 600_000 }).status ?? 1;
		for (const [p, target] of links) {
			let same = false;
			try { same = fs.lstatSync(p).isSymbolicLink() && fs.readlinkSync(p) === target; } catch { /* gone */ }
			if (same) continue;
			fs.rmSync(p, { recursive: true, force: true });
			fs.mkdirSync(path.dirname(p), { recursive: true });
			fs.symlinkSync(target, p);
			console.error(`… kept the development link ${path.relative(ws.root, p)} → ${target}`);
		}
		if (status !== 0) return status;
		// ⚠ npm's exit code is not the answer: a `file:` dependency whose folder does not exist is
		// "added" as a DANGLING link at exit 0. Ready means every declared package now resolves.
		const still = declaredDeps(ws).filter((d) => !resolves(path.join(ws.root, 'node_modules', d)));
		if (still.length) throw new Error(`npm exited 0, but ${still.join(', ')} still do${still.length === 1 ? 'es' : ''} not resolve in node_modules`);
		return 0;
	}),
	env: guard('.env', (ws, st) => placeLink(path.join(st.checkout.primary, '.env'), path.join(ws.root, '.env'))),
	asset: guard('asset', (ws, st, rel) => placeLink(path.join(st.checkout.primary, rel), path.join(ws.root, rel))),
	'git_modules': guard('git modules', (ws) => restoreGitModules(ws)),
	compile: guard('compile', (ws) => compile(ws)),  // `ws` is REOPENED first — see applyInstall
	postinstall: guard('postinstall', (ws, st, rel, stdio) => spawnSync(st.postinstall, { cwd: ws.root, shell: true, stdio, env: { ...childEnv(), DT_PRIMARY: st.checkout.primary } }).status ?? 1),
};

/** Print the board and run the todo steps in order. `dryRun` prints and runs nothing. Returns 1 if
 *  any step errored — one failure never abandons the rest, because a checkout half-made-ready with
 *  a named failure is more useful than one that stopped at the first thing it could not do. */
export async function applyInstall(ws, state, steps, { dryRun = false, log = console.log, stdio = 'inherit', npm = resolveNpm(), open = null } = {}) {
	let failed = 0, installed = false, restored = false;
	for (const s of steps) {
		// ⚠ NEW PACKAGES ARE NEW SOURCES. The plan judged the runtime fresh BEFORE npm put a module (or an
		// extension) into node_modules, so a compiled workspace that just gained a dependency kept the
		// old runtime at exit 0. Once dependencies were installed, the compile runs whatever the plan said.
		// ⚠ A RESTORED LAYER IS A NEW INPUT TOO: compile bakes a layer's package name and data path into the
		// runtime, and staleness hashes sources only — so a layer the git_modules step just cloned left
		// `✔ compile: fresh` and a runtime that did not know it (the first review of 0.46.0, finding eng-03).
		if (s.id === 'compile' && (installed || restored) && s.state === 'already') Object.assign(s, { label: installed ? 'compile: dependencies were just installed' : 'compile: git modules were just restored', state: 'todo' });
		const glyph = s.state === 'todo' ? '▶' : s.state === 'already' ? '✔' : '—';
		log(`${glyph} ${s.label}${s.why ? `\n    ${s.why}` : ''}`);
		if (s.state !== 'todo' || dryRun) continue;
		const [kind, rel] = s.id.split(/:(.+)/);
		// ⚠ COMPILE WITH WHAT WAS JUST INSTALLED. The handle was opened before npm ran, so its
		// extension list predates the packages npm just put in node_modules: a first install compiled an
		// extension's collection as an ordinary one (`storage.base: workspace`) and left the manifest
		// without the provider, and only a second, manual compile repaired it. Reopened here, once.
		if (kind === 'compile' && open) {
			try { ws = await open(ws.root); } catch (e) { failed++; log(`✖ compile: the workspace would not reopen after installing — ${e.message.split('\n')[0]}`); continue; }
		}
		const code = RUN[kind](ws, state, rel, stdio, npm);
		if (code !== 0) { failed++; log(`✖ ${s.id} failed (exit ${code})`); }
		else if (kind === 'dependencies') installed = true;
		else if (kind === 'git_modules') restored = true;
	}
	return failed ? 1 : 0;
}

// ---- the harness hook forms ----------------------------------------------------------------
//
// A hook is not a person: it does not type a target, it hands the engine a JSON object on stdin and
// reads whatever comes back on stdout. Two of this file's verbs grow that form, and one function
// parses the payload for both.

/** The hook's payload, read to EOF. fd 0 rather than a stream, because every caller here is
 *  synchronous and a hook's stdin is a pipe that the harness closes.
 *
 *  ⚠ A TTY DOES NOT COME BACK EMPTY — IT BLOCKS FOREVER (measured). `readFileSync(0)` on a terminal
 *  waits for an EOF the operator has no reason to know he must send, so `dt install --hook` typed
 *  by hand hung silently with no prompt and no output: the worst failure shape a CLI has, because
 *  there is nothing to read and nothing to search for. So the terminal case is refused BEFORE the
 *  read. `isTTY` is a parameter so the refusal can be tested without a pty. A closed or unreadable
 *  descriptor still comes back empty, and `readHookInput` names that one. */
export function readStdin(isTTY = process.stdin.isTTY) {
	if (isTTY) throw new Error('--hook reads the harness\'s JSON on stdin — nothing is piped');
	try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

/** What the harness said, as `{ cwd, name, raw }`. Exported through the public API because an
 *  extension's own hook form (`worktree add --hook`) parses the same payload.
 *
 *  ⚠ THE FIELD NAMES ARE THE HARNESS'S. Claude Code's hooks reference documents every event as
 *  carrying `cwd`, and the two worktree events as additionally carrying `worktree_name` and
 *  `worktree_path` — so `worktree_name` is the primary spelling here and a bare `name` is only the
 *  fallback, not the other way round. `raw` is kept whole because a later verb reads a field these
 *  three do not name (`land` wants `worktree_path`), and because the KEYS are the whole diagnostic
 *  when a hook has been wired to the wrong event: a well-formed payload of the wrong shape is
 *  indistinguishable from a broken one until you can see what it did carry. */
export function readHookInput(stdinText) {
	let raw;
	try { raw = JSON.parse(stdinText); } catch { throw new Error('hook input is not JSON'); }
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('hook input is not JSON');
	const cwd = raw.cwd ?? raw.worktree_path ?? null;
	const name = raw.worktree_name ?? raw.name ?? null;
	if (!cwd && !name) {
		throw new Error(`hook input carries neither a cwd nor a worktree_name — keys received: ${Object.keys(raw).join(', ') || '(none)'}`);
	}
	return { cwd, name, raw };
}

// The hook events and the verb each one runs. Core owns ONE — making the checkout a session opens in
// ready — and an installed extension adds its own (`hooks:` in its contribution; the worktree
// lifecycle belongs to a worktree extension). NO MATCHER on any of them (spec §13.9): bootstrap is
// idempotent precisely so the session-start hook may fire on every event — `startup` alone would
// silence it on resume, clear, compact and fork, which is most of what a long session actually does.
const CLAUDE_HOOKS = { SessionStart: 'install --hook' };

/** Print the harness snippets for this workspace's declared harnesses.
 *
 *  ⚠ NO ABSOLUTE MACHINE PATH IS EVER RENDERED, and the command is `sh <script>` rather than a bare
 *  `npm`/`npx`/`node` — the two constraints that between them decide every character of the line.
 *  `$CLAUDE_PROJECT_DIR` is documented to stay at the MAIN checkout even inside a worktree, which is
 *  exactly the engine wanted: the primary's pinned one, never whatever a fresh worktree lacks. The
 *  worktree's own cwd arrives in the hook's stdin instead.
 *
 *  ⚠ AND THE ENGINE NEVER WRITES A HARNESS SETTINGS FILE. `.claude/settings.json` is the operator's,
 *  reviewed like any config change; a fifth harness channel writing into a user-owned file is a
 *  decision this engine has not made (spec §13.7). So this verb PRINTS — snippets on stdout, so the
 *  output can be piped, and everything else on stderr so it stays parseable. */
export function printAdapters(ws, { harnesses = ws.pkg.dreamteamer?.harnesses ?? ['claude-code'], extensions = ws.extensions ?? [] } = {}) {
	// ⚠ AN EMPTY RENDER IS A REFUSAL, NOT A SUCCESS. The whole point of this verb is that its stdout
	// is redirected into a settings file — so printing nothing at exit 0 writes an EMPTY hooks.json
	// over whatever was there, silently, on the one workspace that never declared the harness.
	if (!harnesses.includes('claude-code')) {
		console.error('no claude-code harness declared — nothing to render');
		return 1;
	}
	for (const h of harnesses) {
		// `claude-code` is the ONLY spelling: it is what KNOWN_HARNESSES holds and what every real
		// package.json carries. The design doc's shorter `claude` names no harness this engine
		// compiles for, so accepting it would only ever mask a misspelling.
		if (h !== 'claude-code') {
			console.error(`${h}: adapter not yet shipped (decision 315)`);
			continue;
		}
		const hooks = {};
		const events = { ...CLAUDE_HOOKS };
		for (const e of extensions) {
			for (const [event, verb] of Object.entries(e.hooks ?? {})) {
				if (events[event]) throw new Error(`extension ${e.name} and ${Object.keys(CLAUDE_HOOKS).includes(event) ? 'the engine' : 'another extension'} both hook ${event} — uninstall or disable one`);
				events[event] = verb;
			}
		}
		for (const [event, verb] of Object.entries(events)) {
			hooks[event] = [{ hooks: [{ type: 'command', command: `sh "$CLAUDE_PROJECT_DIR/node_modules/dreamteamer/bin/dt-hook.sh" ${verb}`, timeout: 600 }] }];
		}
		console.error('# merge into .claude/settings.json — writing it is the operator\'s act, never the engine\'s');
		console.log(JSON.stringify({ hooks }, null, 2));
	}
	return 0;
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
export async function installCommand(ws, rest, { open } = {}) {
	// ⚠ THE OPENER IS REQUIRED, and it must ACTIVATE extensions: the compile step reopens with it (see
	// applyInstall), so a raw `findWorkspace` default compiled an extension's kind as an unknown folder.
	// The public export (api.js) supplies `openWorkspace`; this layer cannot import it.
	if (typeof open !== 'function') throw new Error('installCommand: opts.open (an extension-activating opener, e.g. openWorkspace) is required');
	const flags = new Set(rest.filter((a) => a.startsWith('--')));
	if (flags.has('--print-adapters')) return printAdapters(ws, {});
	const hook = flags.has('--hook');
	// ⚠ NEVER `process.chdir`. The hook runs in the PRIMARY (that is what $CLAUDE_PROJECT_DIR
	// resolves to, worktree or not), and the checkout it is about is the one named on stdin — so the
	// workspace is rebuilt from that path and everything downstream is unchanged. Installing
	// `process.cwd()` instead would print a green board about the wrong checkout on every spawn.
	if (hook) {
		const input = readHookInput(readStdin());
		if (!input.cwd) throw new Error(`hook input carries no cwd — keys received: ${Object.keys(input.raw).join(', ')}`);
		// the checkout the payload names, opened the way the caller opens one (the CLI passes
		// `openWorkspace`, so ITS extensions load — their hooks and kinds are part of that checkout)
		ws = await open(input.cwd);
	}
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
		code = await applyInstall(ws, state, steps, { dryRun: flags.has('--dry-run'), log, stdio: json ? ['ignore', 2, 2] : 'inherit', open });
	} finally {
		console.log = stdout;
	}
	if (json) { console.log(JSON.stringify({ checkout: state.checkout, steps, log: board, code }, null, 2)); return code; }
	// ⚠ THE BOARD IS THE SESSION'S CONTEXT when a session-start hook runs it, so its LAST line says
	// the one thing a session in a linked worktree cannot work out for itself: its records are
	// invisible from the primary until they are committed here.
	if (state.checkout.kind === 'linked') {
		log(`\nthis is linked worktree ${path.basename(ws.root)} of ${state.checkout.primary}; before you finish, dt commit your records here — they are invisible from the primary until you do.`);
	}
	return code;
}

// ---- `dt init` — one command from a folder to a compiled, checked, committed workspace ------------

const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/** Where a write to `p` actually lands: every component resolved in order, a link's target spliced in
 *  and resolved in turn — so a link whose leaf does not exist yet is still followed through each link
 *  among its ancestors, and `..` means the parent of what was REACHED, never the lexical parent. A
 *  missing component ends resolution (nothing below it can be a link). Null past 40 links: a loop. */
function landing(p) {
	const pending = p.split(path.sep);
	let at = path.parse(p).root, hops = 0;
	while (pending.length) {
		const seg = pending.shift();
		if (!seg || seg === '.') continue;
		if (seg === '..') { at = path.dirname(at); continue; }
		const next = path.join(at, seg);
		let st = null;
		try { st = fs.lstatSync(next); } catch { /* absent: created where it is named */ }
		if (!st?.isSymbolicLink()) { at = next; continue; }
		if (++hops > 40) return null;
		const to = fs.readlinkSync(next);
		pending.unshift(...to.split(path.sep));
		if (path.isAbsolute(to)) at = path.parse(to).root;
	}
	return at;
}

/** Would a write to `rel` (root-relative, unnormalised — `a/../b` resolves through `a`) land outside `root`? */
export function escapes(root, rel) {
	const base = fs.realpathSync(root), to = landing(`${base}${path.sep}${rel}`);
	if (to === null) return true;
	const r = path.relative(base, to);
	return r.startsWith('..') || path.isAbsolute(r);
}

/** The links under `rel` (lstat, never descending through one) — compile writes and prunes whole
 *  trees there, so a link anywhere below is a place it writes through. */
function linksUnder(root, rel, out = []) {
	let entries = [];
	try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
	for (const e of entries) {
		const r = path.join(rel, e.name);
		if (e.isSymbolicLink()) out.push(r);
		else if (e.isDirectory()) linksUnder(root, r, out);
	}
	return out;
}

// compile's built-in outputs: the runtime and the harness trees it writes AND prunes (harnesses.js)
const OUTPUT_TREES = [RUNTIME_DIR, '.claude/skills', '.claude/agents', '.claude/commands', '.agents/skills', '.cursor/rules'];

/** Every DIRECTORY link at or under an output tree — the tree's own root included — wherever it points.
 *  ⚠ FAIL CLOSED, not "follow and judge": a link to a folder INSIDE the workspace is harmless as a path
 *  and still hides what is below it (`linksUnder` never descends through a link), so a file link in the
 *  aliased folder carried compile's write outside (third review). Compile makes none of these itself. */
function aliasedOutputDirs(root) {
	const isDirLink = (rel) => { try { return fs.lstatSync(path.join(root, rel)).isSymbolicLink() && fs.statSync(path.join(root, rel)).isDirectory(); } catch { return false; } };
	return OUTPUT_TREES.flatMap((t) => [t, ...linksUnder(root, t)]).filter(isDirLink);
}

/** Every path `init --ready` may write, as init and compile will compute them — the effective block,
 *  the built-in output trees with every link inside them, the managed-block files the last compile
 *  recorded, and any top-level file-position link (a contributed harness writes its block at the root).
 *  `.env` is exempt: never written here, and a worktree's is a link to its primary by design. A folder
 *  link in an output tree never reaches here — `aliasedOutputDirs` refuses it first. NOT covered: a
 *  nested file a newly installed extension's harness writes that no earlier compile recorded. */
function writeFootprint(root, block, flags) {
	let prev = {};
	try { prev = readManifest(root) ?? {}; } catch { /* unreadable: the walk below still judges .dreamteamer/ */ }
	const top = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isSymbolicLink() && e.name !== '.env')
		.filter((e) => { try { return !fs.statSync(path.join(root, e.name)).isDirectory(); } catch { return true; } }).map((e) => e.name);
	return [...new Set([...initFootprint(block, flags), 'package-lock.json', 'node_modules',
		'CLAUDE.md', 'AGENTS.md', 'GEMINI.md', ...(prev['adapter-blocks'] ?? []), ...(prev['adapter-outputs'] ?? []),
		...OUTPUT_TREES, ...OUTPUT_TREES.flatMap((t) => linksUnder(root, t)), ...top].map(String))];
}

/**
 * `dt init [--no-git] [--git <url>] [--no-compile] [--from <dir>] [--input k=v]… [--allow <kind>]… [--no-input]`
 * — from a folder (empty, or a cloned preset, or an existing repo) to a workspace that is pinned to the
 * RUNNING engine, compiled, checked, set up as far as its modules' safe actions go, and committed.
 *
 *  - every path it or compile writes is judged BEFORE the first write (links out of the folder, aliased
 *    output trees, a configured path climbing out), as `init --ready` did
 *  - an engine of another version — declared, locked or installed — is the workspace's choice: refused,
 *    never upgraded (`dt update --engine` is the deliberate move)
 *  - npm runs once: `--save-exact dreamteamer@<this version>` from nothing, or a plain `install` that
 *    restores a preset's lockfile and every module it selected; with `--from <dir>` a missing declared
 *    package comes from that folder of tarballs (`npm install --no-save`), so package.json is untouched
 *  - git: no repository → `git init` and one commit of what init wrote; inside one → the same scoped
 *    commit, the operator's staged work untouched; `--no-git` or no git on PATH → written, not committed,
 *    and the last line says so; `--git <url>` adds `origin` and never pushes
 *  - re-running changes nothing: every step re-checks what is already done
 */
export async function initCommand(flags, { root = process.cwd(), open, verify, npm = resolveNpm(), stdio = 'inherit', log = console.log, processEnv = process.env, tty = !!(process.stdin.isTTY && process.stdout.isTTY), argv = [] } = {}) {
	const want = engineVersion();
	const pkgPath = path.join(root, 'package.json');
	const pkg = fs.existsSync(pkgPath) ? readJson(pkgPath) : {};
	if (!pkg || typeof pkg !== 'object') throw new Error('package.json is not a JSON object — nothing was written');
	// ⚠ EVERY PATH THIS RUN WRITES IS JUDGED BEFORE THE FIRST WRITE. init and compile write through
	// whatever stands at a path, so a `.gitignore` (or `.claude/skills`, or `modules/`) linked out of the
	// folder would have been rewritten wherever it points, and the run would have said ✔. The block is
	// init's OWN merge (`seedBlock`): a safe flag can never hide an unsafe stored value.
	const block = seedBlock(flags, pkg.dreamteamer);
	for (const k of ['workspace_module', 'data_path']) {
		if (block[k] != null && block[k] !== false && typeof block[k] !== 'string') throw new Error(`dreamteamer.${k} must be a path (got ${JSON.stringify(block[k])}) — nothing was written`);
	}
	const aliased = aliasedOutputDirs(root);
	if (aliased.length) throw new Error(`${aliased.join(', ')}: a folder link inside compile's output — compile writes through it, so nothing was written. Replace it with a real folder (or remove it; compile regenerates what it holds)`);
	const out = writeFootprint(root, block, flags).filter((rel) => escapes(root, rel));
	if (out.length) throw new Error(`${out.join(', ')} ${out.length > 1 ? 'resolve' : 'resolves'} outside this workspace — init writes there, so nothing was written. Replace the link (or the configured path) with one inside the folder`);

	// ⚠ THE DECLARATION, THE LOCKFILE AND THE INSTALLED COPY ARE JUDGED EACH ON ITS OWN. Reading only the
	// installed copy let a package.json still declaring an older engine pass — the next clone installs that one.
	const specs = [...new Set(['dependencies', 'devDependencies'].map((k) => pkg[k]?.dreamteamer).filter(Boolean))];
	const locked = readJson(path.join(root, 'package-lock.json'))?.packages?.['node_modules/dreamteamer']?.version ?? null;
	const installed = () => readJson(path.join(root, 'node_modules', 'dreamteamer', 'package.json'))?.version ?? null;
	const upgrade = `init never changes an existing engine — run that version itself (npx dreamteamer@<version> init), or upgrade on purpose: dt update --engine`;
	if (specs.length > 1) throw new Error(`package.json declares dreamteamer twice, differently (${specs.join(' and ')}) — keep one declaration`);
	if (specs[0] && (EXACT.test(specs[0]) ? specs[0] !== want : satisfies(want, specs[0]) === false)) throw new Error(`package.json declares dreamteamer "${specs[0]}", which ${want} is not — ${upgrade}`);
	if (locked && locked !== want) throw new Error(`package-lock.json locks dreamteamer ${locked}, not ${want} — ${upgrade}`);
	if (installed() && installed() !== want) throw new Error(`node_modules holds dreamteamer ${installed()}, not ${want} — ${upgrade}`);
	const fromDir = flags.from ? path.resolve(root, flags.from) : null;
	const fail = (why) => { log(`✖ ${why}\n  the steps after this one did not run — fix it, then run the same command again: every step re-checks what is already done`); return 1; };

	init({ flags, root, commit: false });
	log('✔ skeleton: the package.json dreamteamer block, the workspace module, .gitignore, .env.example — kept where present');
	// EVERY declared package, not just the engine: a preset whose npm install was interrupted holds the
	// engine and lacks the modules it selected, and compile then succeeds without them (`planInstall`'s lesson).
	const now = () => readJson(pkgPath) ?? {};
	const missing = () => Object.keys({ ...now().dependencies, ...now().devDependencies }).sort().filter((d) => !fs.existsSync(path.join(root, 'node_modules', d, 'package.json')));
	const declared = !!(now().dependencies?.dreamteamer ?? now().devDependencies?.dreamteamer);
	let fresh = false;
	if (declared && !missing().length) log(`✔ dependencies: dreamteamer@${want} and every declared package installed`);
	else {
		if (!npm) return fail('cannot install — node found, npm not on PATH');
		let args;
		if (fromDir) {
			// offline: every missing declared package (the engine too, from nothing) comes from the folder
			const { indexFolder } = await import('./install-modules.js');
			let index;
			try { index = indexFolder(fromDir); } catch (e) { return fail(e.message); }
			const need = declared ? missing() : ['dreamteamer', ...missing()];
			const files = [];
			for (const n of need) {
				const hit = n === 'dreamteamer' ? (index.get('dreamteamer') ?? []).find((c) => c.version === want) : (index.get(n) ?? [])[0];
				if (!hit) return fail(`--from ${fromDir}: no ${n === 'dreamteamer' ? `dreamteamer@${want}` : n} in it — nothing was installed`);
				files.push(hit.file);
			}
			args = declared ? ['install', '--no-save', '--no-audit', '--no-fund', ...files] : ['install', '--save-exact', '--no-audit', '--no-fund', ...files];
		} else args = declared ? ['install', '--no-audit', '--no-fund'] : ['install', '--save-exact', '--no-audit', '--no-fund', `dreamteamer@${want}`];
		log(`▶ dependencies: npm ${args.join(' ')}${missing().length ? ` — missing ${missing().join(', ')}` : ''} — downloads packages and runs their npm lifecycle scripts`);
		const r = spawnSync(npm, args, { cwd: root, stdio, env: childEnv(), timeout: 600_000 });
		if (r.status !== 0) return fail(`npm exited ${r.status ?? r.error?.message}`);
		if (missing().length) return fail(`npm finished, but ${missing().join(', ')} ${missing().length > 1 ? 'are' : 'is'} still not installed`);
		if (installed() !== want) return fail(`npm finished, but node_modules/dreamteamer is ${installed() ?? 'missing'}, not ${want}`);
		fresh = true;
	}
	let ws = null;
	let code = 0;
	if (flags['no-compile']) log('— compile: skipped (--no-compile) — run dt compile before a session reads this workspace');
	else {
		try {
			ws = await open(root);
			const s = staleness(root);
			if (fresh || !s.compiled || s.stale.length) { log('▶ compile'); compile(ws); } else log('✔ compile: fresh');
		} catch (e) { return fail(`compile: ${e.message.split('\n')[0]}`); }
		if (await verify(ws)) return fail('check: the violations above');
		// a preset's modules: the safe part of every unit's setup, exactly as `dt install` runs it
		const { units, runUnit, fillInputs, parseInputFlags, parseAllow, skippedUnits, fold, SetupUsage, ttyIO, unitEnv, EXIT } = await import('./setup.js');
		const skipped = new Set(skippedUnits(ws));
		const all = units(ws).filter((u) => !skipped.has(u.id));
		if (all.length) {
			const noInput = !!flags['no-input'];
			const term = tty && !noInput ? ttyIO() : null;
			try {
				const filled = await fillInputs(all, { flags: parseInputFlags(argv), env: unitEnv(ws, processEnv), tty, noInput, prompt: term?.prompt ?? null });
				const allow = parseAllow(argv);
				for (const u of all) {
					const r = await runUnit(ws, u, { inputs: filled.inputs.get(u.id) ?? {}, allow, tty, ask: term?.ask ?? null, processEnv });
					const miss = filled.missing.filter((m) => m.unit === u.id).map((m) => m.id);
					const f = fold(r.checks, {});
					log(`${f.state === 'ready' ? '✔' : '—'} ${u.id}: ${f.state}${f.detail ? ` — ${f.detail}` : ''}`);
					for (const a of r.applied) log(`    ✔ ${a.id}${a.message ? ` — ${a.message}` : ''}`);
					for (const x of r.failed) log(`    ✖ ${x.id} — ${x.message}`);
					for (const pnd of r.pending) log(`    … ${pnd.id} (${pnd.why})`);
					if (miss.length) { log(`    needs input: ${miss.join(', ')} — dt setup ${u.id} --input ${miss[0]}=<value>`); code = 3; }
				}
			} catch (e) {
				if (e instanceof SetupUsage) { fail(e.message); return EXIT.usage; }
				throw e;
			} finally { term?.close(); }
		}
	}
	// git — a repository, a remote, one scoped commit; never the operator's own staged work
	const hasGit = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
	const isRepo = () => hasGit && spawnSync('git', ['rev-parse', '--git-dir'], { cwd: root, stdio: 'ignore' }).status === 0;
	if (flags['no-git']) log('— git: skipped (--no-git) — `git status` shows what init wrote');
	else if (!hasGit) log('— git: not on PATH — nothing was committed; `git status` shows what init wrote once it is');
	else {
		if (!isRepo()) { spawnSync('git', ['init', '--quiet'], { cwd: root, stdio: 'ignore' }); log('✔ git: repository created (local, no account)'); }
		if (flags.git) {
			const has = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, stdio: 'ignore' }).status === 0;
			if (!has) { spawnSync('git', ['remote', 'add', 'origin', flags.git], { cwd: root, stdio: 'ignore' }); log(`✔ git: origin → ${flags.git} (never pushed)`); } else log('✔ git: origin already set — left as it is');
		}
		const wm = now().dreamteamer?.workspace_module;
		const paths = ['package.json', 'package-lock.json', '.gitignore', '.env.example', '.vscode/extensions.json', ...(wm ? [`modules/${wm}/package.json`, `modules/${wm}/collections/notes.collection.yaml`] : ['collections/notes.collection.yaml'])].filter((rel) => fs.existsSync(path.join(root, rel)));
		const r = spawnSync('git', ['add', '--', ...paths], { cwd: root, stdio: 'ignore' });
		const c = r.status === 0 ? spawnSync('git', ['commit', '--quiet', '-m', `dreamteamer: init workspace ${now().name ?? path.basename(root)}`, '--', ...paths], { cwd: root, encoding: 'utf8' }) : r;
		if (c.status === 0) log(`✔ git: committed ${paths.join(', ')}`);
		else if (/nothing to commit|no changes added/.test(`${c.stdout ?? ''}${c.stderr ?? ''}`)) log('✔ git: nothing new to commit');
		else log(`⚠ git: commit did not happen (${(c.stderr ?? '').trim().split('\n')[0] || `exit ${c.status}`}) — \`git status\` shows what init wrote`);
	}
	if (ws) {
		const { statusLines, renderStatusLines } = await import('./setup.js');
		try { for (const line of renderStatusLines(statusLines(ws, { processEnv }))) log(line); } catch { /* status is a courtesy here */ }
	}
	log(`\nready: dreamteamer@${want}${flags['no-compile'] ? ' (not compiled)' : ', compiled and checked'}. Next: dt install <package> adds a module; dt status says what works here.`);
	return code;
}
