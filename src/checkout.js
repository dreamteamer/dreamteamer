// src/checkout.js — which checkout am I, and how does it become ready.
// WORKSPACE layer: knows git and the compiler, never the harness.
import path from 'node:path';
import fs, { realpathSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { staleness, compile, discoverModules } from './compile.js';
import { install as restoreGitModules } from './init.js';
import { findWorkspace } from './workspace.js';

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
	const beside = path.join(path.dirname(execPath), bin);
	if (resolves(beside)) return beside;
	for (const dir of (env.PATH ?? '').split(path.delimiter)) {
		if (dir && resolves(path.join(dir, bin))) return path.join(dir, bin);
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
const childEnv = () => ({ ...process.env, PATH: [path.dirname(process.execPath), process.env.PATH ?? ''].filter(Boolean).join(path.delimiter) });

// One executor per step id, keyed by the id's kind. None decides ANYTHING — whether a step runs at
// all was settled by `planInstall`. `stdio` is the caller's, so a `--json` run can send a
// subprocess's chatter to stderr and keep stdout for the payload.
const RUN = {
	engine: guard('engine', (ws, st, rel, stdio) => {
		const npm = resolveNpm();
		// ⚠ THE HONEST BOARD LINE, not a crash. `npm` is missing far more often than `node` is —
		// a hook's `sh` finds neither, and the shim resolves only node — so the step has to say
		// WHICH of the two it could not find. `✖ engine:` is prepended by the guard.
		if (!npm) throw new Error('cannot install — node found, npm not on PATH');
		return spawnSync(npm, [fs.existsSync(path.join(ws.root, 'package-lock.json')) ? 'ci' : 'install', '--prefer-offline', '--no-audit', '--no-fund'], { cwd: ws.root, stdio, env: childEnv() }).status ?? 1;
	}),
	env: guard('.env', (ws, st) => placeLink(path.join(st.checkout.primary, '.env'), path.join(ws.root, '.env'))),
	asset: guard('asset', (ws, st, rel) => placeLink(path.join(st.checkout.primary, rel), path.join(ws.root, rel))),
	'git-modules': guard('git modules', (ws) => restoreGitModules(ws)),
	compile: guard('compile', (ws) => compile(ws)),
	postinstall: guard('postinstall', (ws, st, rel, stdio) => spawnSync(st.postinstall, { cwd: ws.root, shell: true, stdio, env: { ...childEnv(), DT_PRIMARY: st.checkout.primary } }).status ?? 1),
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

// ---- the harness hook forms ----------------------------------------------------------------
//
// A hook is not a person: it does not type a target, it hands the engine a JSON object on stdin and
// reads whatever comes back on stdout. Two of this file's verbs grow that form, and one function
// parses the payload for both.

/** The hook's payload, read to EOF. fd 0 rather than a stream, because every caller here is
 *  synchronous and a hook's stdin is a pipe that the harness closes. A stdin that cannot be read at
 *  all (a TTY, a closed descriptor) comes back empty, and `readHookInput` names that. */
const readStdin = () => { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } };

/** What the harness said, as `{ cwd, name, raw }`.
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

// The three worktree-lifecycle events and the verb each one runs. NO MATCHER on any of them
// (spec §13.9): bootstrap is idempotent precisely so the session-start hook may fire on every
// event — `startup` alone would silence it on resume, clear, compact and fork, which is most of
// what a long worktree session actually does.
const CLAUDE_HOOKS = {
	SessionStart: 'install --hook',
	WorktreeCreate: 'add worktrees --hook',
	WorktreeRemove: 'land --hook --dry-run',
};

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
export function printAdapters(ws, { harnesses = ws.pkg.dreamteamer?.harnesses ?? ['claude-code'] } = {}) {
	for (const h of harnesses) {
		// `claude` is the spelling the design doc uses; `claude-code` is the one KNOWN_HARNESSES and
		// every real package.json carry. Both name the same adapter, and matching only the former
		// would print "not yet shipped" on every workspace that exists.
		if (h !== 'claude-code' && h !== 'claude') {
			console.error(`${h}: adapter not yet shipped (decision 311) — see using-dreamteamer › worktrees.md`);
			continue;
		}
		const hooks = {};
		for (const [event, verb] of Object.entries(CLAUDE_HOOKS)) {
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
export function installCommand(ws, rest) {
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
		ws = findWorkspace(input.cwd);
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
		code = applyInstall(ws, state, steps, { dryRun: flags.has('--dry-run'), log, stdio: json ? ['ignore', 2, 2] : 'inherit' });
	} finally {
		console.log = stdout;
	}
	if (json) { console.log(JSON.stringify({ checkout: state.checkout, steps, log: board, code }, null, 2)); return code; }
	// ⚠ THE BOARD IS THE SESSION'S CONTEXT when a session-start hook runs it, so its LAST line is
	// the landing instruction (spec §13.10) — the one thing a spawned session cannot work out for
	// itself and the one thing it has to do before it finishes.
	if (state.checkout.kind === 'linked') {
		const name = path.basename(ws.root);
		log(hook
			? `\nthis is worktree ${name} of ${state.checkout.primary}; before you finish, dt commit your records and tell the operator to run dt land worktrees/${name}`
			: `\nbefore you finish here: dt commit your records, then the operator runs dt land worktrees/${name}.`);
	}
	return code;
}

// ---- worktrees: an OBSERVED entity ---------------------------------------------------------
//
// There is no `worktrees` collection and no record. `git worktree list` is the authority, and a
// stored copy of it could only ever drift — a worktree the operator removed by hand, a branch
// deleted from the primary, a directory moved. So every row below is DERIVED: git's porcelain plus
// two cheap reads per row (the dirty records under the data path, and whether a manifest is there).

/** Every checkout of this repo, primary first, as git reports it.
 *
 *  ⚠ `ahead` IS NULL FOR A DETACHED WORKTREE, not 0 — `rev-list <primary>..<no branch>` has nothing
 *  to count, and `--detach` is how anyone bisects, so the null case is ordinary rather than exotic.
 *  `dirtyRecords` is deliberately scoped to the DATA path: uncommitted records are the thing that
 *  cannot be recovered from the primary, and they are invisible from it. */
export function listWorktrees(ws, git = defaultGit) {
	const c = describeCheckout(ws.root, git);
	const primaryBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], c.primary);
	const dataPath = ws.pkg.dreamteamer?.['data-path'] ?? 'data';
	const rows = [];
	let cur = null;
	for (const line of git(['worktree', 'list', '--porcelain'], c.primary).split('\n')) {
		if (line.startsWith('worktree ')) { cur = { path: line.slice(9), branch: null, head: null }; rows.push(cur); }
		else if (line.startsWith('HEAD ')) cur.head = line.slice(5, 12);
		else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
	}
	return rows.map((w) => {
		const primary = real(w.path) === real(c.primary);
		// ⚠ THE NAME IS WHAT WAS TYPED, not the directory it landed in. `--path` lets the two
		// differ, and the name is what `get`, the duplicate guard and the branch cleanup key on —
		// so it is recovered from the branch this verb creates, which is the only place git keeps
		// it. A worktree on someone else's branch, or a detached one, has nothing but its basename.
		const name = !primary && w.branch?.startsWith('worktree-') ? w.branch.slice('worktree-'.length) : path.basename(w.path);
		let ahead = null;
		if (w.branch && !primary) {
			try { ahead = Number(git(['rev-list', '--count', `${primaryBranch}..${w.branch}`], c.primary)); } catch { ahead = null; }
		}
		let dirtyRecords = 0;
		try { dirtyRecords = git(['status', '--porcelain', '--', dataPath], w.path).split('\n').filter(Boolean).length; } catch { /* unreadable tree — a moved or deleted directory */ }
		return {
			name, path: w.path, branch: w.branch, head: w.head, primary, ahead, dirtyRecords,
			bootstrapped: resolves(path.join(w.path, '.dreamteamer', 'manifest.yaml')),
		};
	});
}

/** A worktree by name or by path — one id shape, two spellings, because the name is what an
 *  operator types and the path is what a creation hook echoes. The PATH is tried first, since it is
 *  unique by construction and a name is not.
 *
 *  ⚠ AN AMBIGUOUS NAME IS REFUSED, never resolved to whichever row git listed first. Two --temp
 *  sandboxes may share a name — their random holders keep the paths distinct, which is the whole
 *  point of having one — and silently picking one of them is how a removal lands on the wrong
 *  sandbox and takes work with it. */
function findWorktree(ws, ref) {
	if (!ref) return null;
	const rows = listWorktrees(ws);
	const byPath = rows.find((w) => real(w.path) === real(path.resolve(ws.root, ref)));
	if (byPath) return byPath;
	const byName = rows.filter((w) => w.name === ref);
	if (byName.length > 1) {
		throw new Error(`"${ref}" names ${byName.length} worktrees — address one by path:\n  ${byName.map((w) => `worktrees/${w.path}`).join('\n  ')}`);
	}
	return byName[0] ?? null;
}

/** The engine binary that is RUNNING — never `node_modules/dreamteamer` resolved in the workspace.
 *  The new tree may have no node_modules at all yet, and the engine the operator invoked is the one
 *  that should make it ready. */
const engineBin = () => fileURLToPath(new URL('../bin/dreamteamer.js', import.meta.url));

/**
 * The worktree, MADE — everything `addWorktree` does except the final `console.log`, and the path it
 * returns is that same line. Split out for `dt prove`, whose `writes` sandbox is a `--temp` worktree
 * it has to keep the path of rather than read back off stdout.
 *
 * ⚠ `quiet` EXTENDS THE OPTION BAG, and it is not cosmetic. The install step runs with
 * `stdio: 'inherit'`, so a caller printing a machine-readable stream (`dt prove --json` emits ONE
 * object on stdout and nothing else) would have a compile transcript spliced in ahead of it.
 * `addWorktree` never passes it, so what a `dt add worktrees` prints is unchanged.
 */
export function createWorktree(ws, { name, dir, base = 'HEAD', temp = false, quiet = false }, git = defaultGit) {
	if (!name) throw new Error('dt add worktrees needs --name <name>');
	const c = describeCheckout(ws.root, git);
	// ⚠ A --temp SANDBOX MAY REUSE A NAME, and refusing the second one would half-defeat the random
	// holder that exists to allow it. So a sandbox is addressed by the PATH `add` printed, and the
	// ambiguous name is refused at the READ instead (findWorktree).
	if (!temp && findWorktree(ws, name)) throw new Error(`worktree "${name}" already exists — dt get worktrees/${name}`);
	if (!temp && git(['branch', '--list', `worktree-${name}`], c.primary)) {
		throw new Error(`branch worktree-${name} already exists — pick another name or delete the branch`);
	}
	// ⚠ --temp LIVES INSIDE THE PRIMARY ROOT TOO: `.worktrees/.tmp-<rand>/<name>`. Two measured
	// reasons, neither cosmetic. `.env` is linked only for a worktree under the primary root, so a
	// sandbox outside it would never get credentials; and git records the REALPATH of a worktree,
	// while macOS resolves /var to /private/var — so an os.tmpdir() sandbox compares unequal to its
	// own row in `git worktree list` and could be neither got nor removed by the path it printed.
	// ⚠ NOT ACCEPTED AND IGNORED. --temp places the sandbox itself, so a --path alongside it names a
	// directory that would silently not be the one made.
	if (temp && dir) throw new Error('--temp places the sandbox itself (.worktrees/.tmp-<rand>/<name>) — pass either --temp or --path <dir>, not both');
	const holder = path.join(c.primary, '.worktrees');
	if (temp) fs.mkdirSync(holder, { recursive: true });
	// ⚠ NEVER PRE-CREATE `target`: `git worktree add` creates it, and an empty pre-created folder is
	// swept by compile's empty-directory pass.
	const sandbox = temp ? fs.mkdtempSync(path.join(holder, '.tmp-')) : null;
	const target = sandbox ? path.join(sandbox, name) : path.resolve(ws.root, dir ?? path.join(holder, name));
	try {
		git(temp ? ['worktree', 'add', '--detach', target, base] : ['worktree', 'add', '-b', `worktree-${name}`, target, base], c.primary);
	} catch (e) {
		// The holder was made a line ago and holds nothing yet: a bad --base would otherwise leave
		// an empty `.tmp-<rand>` behind, and `.worktrees/` is ignored, so nobody would ever see it.
		if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
		throw e;
	}
	// The engine must be reachable from the new tree before `install` can compile there. When THIS
	// tree's node_modules/dreamteamer is a SYMLINK (a dev shadow, a test fixture) mirror that ONE
	// link — never the node_modules directory, which is a real folder holding it. Otherwise
	// install's own engine step runs npm there, so a real workspace pays one `npm ci` per worktree
	// and per --temp sandbox (from the npm cache).
	const eng = path.join(ws.root, 'node_modules', 'dreamteamer');
	if (isLink(eng)) {
		fs.mkdirSync(path.join(target, 'node_modules'), { recursive: true });
		fs.symlinkSync(realpathSync(eng), path.join(target, 'node_modules', 'dreamteamer'), 'dir');
	}
	const r = spawnSync(process.execPath, [engineBin(), 'install'], { cwd: target, stdio: quiet ? 'pipe' : 'inherit' });
	if (r.status !== 0) console.warn(`⚠ install inside ${target} exited ${r.status} — the worktree exists; re-run dt install there`);
	return target;
}

/** `dt add worktrees --name <name>`. Contract: the PATH is the last line, and the code is 0. */
export function addWorktree(ws, opts, git = defaultGit) {
	const target = createWorktree(ws, opts, git);
	console.log(target); // LAST line, by contract: a creation hook echoes it
	return 0;
}

/** ⚠ IT REFUSES BY DEFAULT, AND THE REASON IS NAMED. A worktree holds two things the primary cannot
 *  see: records written but not committed, and commits not yet landed. `git worktree remove` knows
 *  about neither — it checks a dirty tree and stops there — so the records, the one thing this
 *  engine exists to keep, are exactly what a bare `remove` would take with it. */
export function removeWorktree(ws, ref, { force = false } = {}, git = defaultGit) {
	const w = findWorktree(ws, ref);
	if (!w) throw new Error(`no worktree "${ref}" — dt list worktrees`);
	if (w.primary) throw new Error('refusing to remove the primary checkout');
	const c = describeCheckout(ws.root, git);
	const primaryBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], c.primary);
	// ⚠ THE DATA-LOSS PATH, and `--temp` makes it the ordinary one. `ahead` is null for a DETACHED
	// worktree by construction (the field is specified that way and pinned by its own test), and
	// `git worktree remove` checks only modified and untracked files — never reachability. So a
	// sandbox whose work had been COMMITTED read as clean with nothing ahead and was removed at exit
	// 0, orphaning every commit the moment its HEAD went with it.
	//
	// ⚠ AND THE DETACHED QUESTION IS A DIFFERENT QUESTION. A branch's work is held by the branch and
	// merely un-LANDED (`primaryBranch..branch`, fixed by a merge); a detached HEAD's work is held by
	// nothing but the HEAD about to be deleted, i.e. ORPHANED — so the measure is "reachable from no
	// ref at all", and once any branch holds it the removal is safe. `--not --all` cannot answer
	// this: `--all` examines every working tree, the sandbox's own HEAD included, so it answered 0
	// for the very commits at risk (measured). `--branches --tags --remotes` is the honest ref set.
	//
	// ⚠ AND IT FAILS CLOSED. This measurement is what the refusal turns on, so a `catch` that set it
	// back to null answered "nothing ahead" for a measurement that never ran — no refusal fired and
	// the destructive removal went through at exit 0, which is the exact loss the guard exists to
	// prevent, reached by the one path nobody walks. An unmeasured guard is a refusal, not a pass.
	//
	// ⚠ SO THE RAW STRING IS VALIDATED, NOT THE NUMBER, and the difference is a data-loss bug.
	// `Number('')` is 0 and `Number.isInteger(0)` is true, so an integer check waves an EMPTY answer
	// through as "nothing ahead" — the same fail-open, one layer down. `/^\d+$/` is the only gate
	// that separates "git counted zero" from "git said nothing"; `Number()` runs after it, on a
	// string already known to be a count. (`git` is an exported PARAMETER of this function, so the
	// trimming, exit-code-checking `defaultGit` is not the only runner this has to survive.)
	let ahead = w.ahead;
	let unmeasured = null;
	const orphaned = w.ahead === null && !w.primary && w.head;
	if (orphaned) {
		try {
			const out = String(git(['rev-list', '--count', w.head, '--not', '--branches', '--tags', '--remotes'], c.primary) ?? '').trim();
			if (/^\d+$/.test(out)) ahead = Number(out);
			else unmeasured = out ? `git rev-list answered "${out}", which is not a count` : 'git rev-list answered nothing';
		} catch (e) { unmeasured = String(e.message ?? e).split('\n')[0]; }
	}
	if (!force) {
		// The unmeasured case leads, because it is the one refusal that cannot name what is at risk:
		// a detached worktree's commits are held by nothing but the HEAD about to be deleted.
		if (unmeasured) {
			throw new Error(`refusing to remove worktree "${w.name}": whether its commits are reachable from anything else could not be measured — ${unmeasured}\n  ${w.head} is held by nothing but this worktree unless a ref names it: git branch <name> ${w.head} to keep it, or --force to remove without the check`);
		}
		// ⚠ THE DIRECTORY CAN BE GONE while git still lists the worktree — someone deleted it by
		// hand. `list` already reports that (NOT installed); here, reading its dirty state in a cwd
		// that does not exist died as `✖ spawnSync git ENOENT`, a message about the wrong thing
		// entirely on the one state where dropping the registration cannot lose anything.
		if (!resolves(w.path)) throw new Error(`worktree "${w.name}" is registered but its directory is gone (${w.path}) — nothing to lose: dt rm worktrees/${w.name} --force drops the registration`);
		const dirty = git(['status', '--porcelain'], w.path).split('\n').filter(Boolean).length;
		const why = [];
		if (w.dirtyRecords) why.push(`${w.dirtyRecords} dirty record(s) — dt commit them, or --force to discard`);
		else if (dirty) why.push(`${dirty} uncommitted change(s) — commit or --force`);
		if (ahead && orphaned) why.push(`${ahead} commit(s) reachable from NOTHING but this worktree — git branch <name> ${w.head} to keep them, or --force to discard`);
		else if (ahead) why.push(`${ahead} commit(s) not on ${primaryBranch} — merge branch ${w.branch}, or --force to discard`);
		if (why.length) throw new Error(`refusing to remove worktree "${w.name}":\n  ${why.join('\n  ')}`);
	}
	git(['worktree', 'remove', ...(force ? ['--force'] : []), w.path], c.primary);
	// Only a branch this verb CREATED is deleted with the worktree. A worktree checked out on `main`
	// or on someone's feature branch keeps it — and SAYS SO, because a branch left behind silently
	// is a branch nobody knows to look at: `list` cannot show it once the worktree is gone.
	if (w.branch === `worktree-${w.name}`) {
		try { git(['branch', force ? '-D' : '-d', w.branch], c.primary); } catch { console.warn(`⚠ branch ${w.branch} kept (not merged)`); }
	} else if (w.branch) {
		console.log(`  branch ${w.branch} kept — it is not the worktree-${w.name} this verb creates`);
	}
	// A sandbox lives alone in its own `.tmp-<rand>` holder; nothing else does. The holder goes with
	// it, or every sandbox ever cut leaves an empty directory behind for ever — and `.worktrees/` is
	// ignored, which is exactly why it would accumulate unnoticed.
	const holder = path.dirname(w.path);
	if (path.basename(holder).startsWith('.tmp-') && path.dirname(holder) === path.join(c.primary, '.worktrees')) {
		try { fs.rmdirSync(holder); } catch { /* not empty — something else is in there */ }
	}
	console.log(`✔ removed worktree ${w.name}`);
	return 0;
}

/** `dt list|get|add|rm worktrees[/<ref>]`. The flags arrive PARSED and already refused by the
 *  surface — `worktrees` has no descriptor, so nothing downstream would catch a typo. */
export function worktreeCommand(ws, verb, target, flags = {}) {
	// A repeated flag arrives as an array (the parser promotes rather than overwrites). Every flag
	// here holds ONE value, so a repeat is a mistake — and a silent last-one-wins would spell
	// `--name a --name b` as the branch `worktree-a,b`.
	const one = (k) => {
		if (Array.isArray(flags[k])) throw new Error(`--${k} was given ${flags[k].length} times and takes ONE value: ${flags[k].map((x) => `--${k} ${x}`).join(' ')}`);
		return typeof flags[k] === 'string' ? flags[k] : undefined;
	};
	const json = !!flags.json;
	// SLICE, never split: `worktrees//abs/path` is one valid id, and a split at '/' mangles it.
	const id = target.startsWith('worktrees/') ? target.slice('worktrees/'.length) : null;
	const needId = () => { if (!id) throw new Error(`dt ${verb} needs a worktree: dt ${verb} worktrees/<name>`); return id; };
	switch (verb) {
		case 'list': {
			const rows = listWorktrees(ws);
			if (json) console.log(JSON.stringify(rows, null, 2));
			else for (const w of rows) {
				console.log(`${w.primary ? '●' : '○'} ${w.name.padEnd(24)} ${(w.branch ?? '(detached)').padEnd(28)} ${w.head}  ahead ${w.ahead ?? '—'}  dirty records ${w.dirtyRecords}  ${w.bootstrapped ? 'installed' : 'NOT installed'}  ${w.path}`);
			}
			return 0;
		}
		case 'get': {
			const w = findWorktree(ws, needId());
			if (!w) throw new Error(`no worktree "${id}" — dt list worktrees`);
			console.log(json ? JSON.stringify(w, null, 2) : Object.entries(w).map(([k, v]) => `${k}: ${v}`).join('\n'));
			return 0;
		}
		case 'add': {
			// ⚠ THE HOOK IMPLIES THE PLACEMENT, and it is `.worktrees/`, never `.claude/worktrees/`.
			// `.worktrees/` is already gitignored by every workspace `init` writes, while anything
			// under `.claude` sits inside compile's empty-directory sweep — so the primary's next
			// compile would walk a LIVE worktree and delete its empty folders. Claude's own placement
			// logic is replaced by this hook, so the path printed last is the path it then uses.
			if (!flags.hook) return addWorktree(ws, { name: one('name'), dir: one('path'), base: one('base'), temp: !!flags.temp });
			const input = readHookInput(readStdin());
			if (!input.name) throw new Error(`hook input carries no worktree_name — keys received: ${Object.keys(input.raw).join(', ')}`);
			return addWorktree(ws, { name: input.name, dir: path.join('.worktrees', input.name) });
		}
		case 'rm': return removeWorktree(ws, needId(), { force: !!flags.force });
		default: throw new Error(`dt ${verb} does not apply to worktrees — they take list · get · add · rm`);
	}
}
