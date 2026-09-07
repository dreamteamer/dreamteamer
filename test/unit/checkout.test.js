import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeCheckout, defaultGit, planInstall, readHookInput, readStdin, resolveNpm, applyInstall } from '../../src/checkout.js';

const fakeGit = (answers) => (args) => answers[args.join(' ')] ?? '';

describe('describeCheckout — primary vs linked, from git alone', () => {
	test('a primary checkout: git-dir and common-dir agree', () => {
		const c = describeCheckout('/w/ws', fakeGit({ 'rev-parse --git-dir': '.git', 'rev-parse --git-common-dir': '.git' }));
		assert.equal(c.kind, 'primary');
		assert.equal(c.primary, '/w/ws');
		assert.equal(c.insideRoot, true);
	});
	test('a linked worktree under the primary root', () => {
		const c = describeCheckout('/w/ws/.worktrees/a', fakeGit({
			'rev-parse --git-dir': '/w/ws/.git/worktrees/a', 'rev-parse --git-common-dir': '/w/ws/.git' }));
		assert.equal(c.kind, 'linked');
		assert.equal(c.primary, '/w/ws');
		assert.equal(c.insideRoot, true);
		// later tasks read these two to place the engine and to find the worktree's own git dir
		assert.equal(c.gitDir, '/w/ws/.git/worktrees/a');
		assert.equal(c.commonDir, '/w/ws/.git');
	});
	test('a linked worktree outside the primary root (a home-directory location)', () => {
		const c = describeCheckout('/home/u/.codex/worktrees/x/ws', fakeGit({
			'rev-parse --git-dir': '/w/ws/.git/worktrees/x', 'rev-parse --git-common-dir': '/w/ws/.git' }));
		assert.equal(c.kind, 'linked');
		assert.equal(c.primary, '/w/ws');
		assert.equal(c.insideRoot, false);
	});
	test('a SUBDIRECTORY of a primary checkout still reports the primary, not the subdirectory', () => {
		// what real git answers from a subdir: an absolute --git-dir and a relative --git-common-dir
		const c = describeCheckout('/w/ws/sub', fakeGit({
			'rev-parse --git-dir': '/w/ws/.git', 'rev-parse --git-common-dir': '../.git' }));
		assert.equal(c.kind, 'primary');
		assert.equal(c.primary, '/w/ws');
		assert.equal(c.insideRoot, true);
	});
	test('root is normalized, so a trailing slash or a relative path cannot leak into the answer', () => {
		const answers = { 'rev-parse --git-dir': '.git', 'rev-parse --git-common-dir': '.git' };
		assert.equal(describeCheckout('/w/ws/', fakeGit(answers)).root, '/w/ws');
		const here = describeCheckout('.', fakeGit(answers));
		assert.equal(here.root, process.cwd());
		assert.equal(here.primary, process.cwd());
	});
	test('not a git checkout at all throws a named error', () => {
		assert.throws(() => describeCheckout('/w/ws', () => { throw new Error('fatal: not a git repository'); }), /not a git checkout/);
	});
	test('defaultGit is exported, so a caller gets the real runner without building one', () => {
		assert.equal(typeof defaultGit, 'function');
	});
});

const linked = (over = {}) => ({ checkout: { kind: 'linked', primary: '/w/ws', root: '/w/ws/.worktrees/a', insideRoot: true }, hasEngine: true,
	hasEnv: false, primaryHasEnv: true, envIsLink: false, localAssets: [], gitModules: [], stale: true, postinstall: null, ...over });
const byId = (steps, id) => steps.find((s) => s.id === id);

describe('planInstall — every step checks before it acts', () => {
	test('a linked worktree under the root links .env when the primary has one', () => {
		assert.equal(byId(planInstall(linked()), 'env').state, 'todo');
	});
	test('a worktree OUTSIDE the root does not link .env unless --link-env', () => {
		const s = linked({ checkout: { kind: 'linked', primary: '/w/ws', root: '/home/u/x', insideRoot: false } });
		assert.equal(byId(planInstall(s), 'env').state, 'skip');
		assert.match(byId(planInstall(s), 'env').why, /outside the primary root/);
		assert.equal(byId(planInstall(s, { linkEnv: true }), 'env').state, 'todo');
	});
	test('a regular .env already here is left alone and named', () => {
		const step = byId(planInstall(linked({ hasEnv: true, envIsLink: false })), 'env');
		assert.equal(step.state, 'already'); assert.match(step.label, /carries its own \.env/);
	});
	test('a primary checkout never gets an env step beyond "primary"', () => {
		const s = linked({ checkout: { kind: 'primary', primary: '/w/ws', root: '/w/ws', insideRoot: true } });
		assert.equal(byId(planInstall(s), 'env').state, 'skip');
	});
	test('a primary with no .env of its own leaves nothing to link', () => {
		// the only guard between this state and the todo branch below it — delete it and the plan
		// tells the runner to symlink a file that does not exist
		assert.equal(byId(planInstall(linked({ primaryHasEnv: false })), 'env').state, 'skip');
	});
	test('a local asset present in the primary and absent here is linked; absent in the primary is skipped with a line', () => {
		const s = linked({ localAssets: [
			{ rel: 'modules/m/skills/t/.models', module: 'm', presentHere: false, isLinkHere: false, presentInPrimary: true },
			{ rel: '.profiles', module: null, presentHere: false, isLinkHere: false, presentInPrimary: false } ] });
		const steps = planInstall(s);
		assert.equal(byId(steps, 'asset:modules/m/skills/t/.models').state, 'todo');
		assert.equal(byId(steps, 'asset:.profiles').state, 'skip');
	});
	test('a real directory already here is never replaced by a link', () => {
		const s = linked({ localAssets: [{ rel: '.profiles', module: null, presentHere: true, isLinkHere: false, presentInPrimary: true }] });
		assert.equal(byId(planInstall(s), 'asset:.profiles').state, 'already');
	});
	test('a primary checkout links no asset either — there is nowhere to link from', () => {
		const s = linked({ checkout: { kind: 'primary', primary: '/w/ws', root: '/w/ws', insideRoot: true },
			localAssets: [{ rel: '.profiles', module: null, presentHere: false, isLinkHere: false, presentInPrimary: true }] });
		assert.equal(byId(planInstall(s), 'asset:.profiles').state, 'skip');
	});
	test('engine absent → the npm step is todo; present → already', () => {
		assert.equal(byId(planInstall(linked({ hasEngine: false })), 'engine').state, 'todo');
		assert.equal(byId(planInstall(linked()), 'engine').state, 'already');
	});
	test('compile only when stale; postinstall only when declared; postinstall is LAST', () => {
		const steps = planInstall(linked({ stale: false, postinstall: 'node bin/post.mjs' }));
		assert.equal(byId(steps, 'compile').state, 'already');
		assert.equal(steps.at(-1).id, 'postinstall'); assert.equal(steps.at(-1).state, 'todo');
		assert.equal(byId(planInstall(linked()), 'postinstall').state, 'skip');
	});
	test('a second run is all "already"/"skip" — nothing todo', () => {
		const s = linked({ hasEnv: true, envIsLink: true, stale: false });
		assert.ok(planInstall(s).every((x) => x.state !== 'todo'));
		// gitModules is the MISSING clones, so an empty one means restored, not undeclared
		assert.match(byId(planInstall(s), 'git-modules').label, /nothing to restore/);
	});
	test('the id order IS the contract Task 3 renders — engine, env, assets, git modules, compile, postinstall', () => {
		const s = linked({ localAssets: [{ rel: '.profiles', module: null, presentHere: false, isLinkHere: false, presentInPrimary: true }] });
		assert.deepEqual(planInstall(s).map((x) => x.id),
			['engine', 'env', 'asset:.profiles', 'git-modules', 'compile', 'postinstall']);
	});
});

// ---- readHookInput -------------------------------------------------------------------------
//
// ⚠ THE FIELD NAMES ARE THE HARNESS'S, NOT OURS. Claude Code's hooks reference (fetched
// 2026-09-07) documents `WorktreeCreate`/`WorktreeRemove` as carrying `worktree_name` and
// `worktree_path` beside the `cwd` every event has — so the plain `name` an interface sketch
// would reach for is the FALLBACK spelling here, never the primary one. A parser that read only
// `name` would have answered "no worktree name" to a perfectly well-formed WorktreeCreate.
describe('readHookInput — the harness speaks JSON on stdin', () => {
	test('a SessionStart payload yields its cwd', () => {
		const i = readHookInput(JSON.stringify({ session_id: 's1', cwd: '/w/ws/.worktrees/a', hook_event_name: 'SessionStart' }));
		assert.equal(i.cwd, '/w/ws/.worktrees/a');
		assert.equal(i.name, null);
		assert.equal(i.raw.hook_event_name, 'SessionStart');
	});
	test('a WorktreeCreate payload yields the DOCUMENTED worktree_name', () => {
		const i = readHookInput(JSON.stringify({ cwd: '/w/ws', hook_event_name: 'WorktreeCreate', worktree_name: 'probe', worktree_path: '/w/ws/.worktrees/probe' }));
		assert.equal(i.name, 'probe');
		assert.equal(i.cwd, '/w/ws');
		assert.equal(i.raw.worktree_path, '/w/ws/.worktrees/probe', 'the raw payload is kept — land reads worktree_path off it');
	});
	test('a bare `name` still works — the fallback spelling', () => {
		assert.equal(readHookInput('{"name":"probe"}').name, 'probe');
	});
	test('worktree_path stands in for a payload with no cwd', () => {
		assert.equal(readHookInput('{"worktree_path":"/w/ws/.worktrees/a"}').cwd, '/w/ws/.worktrees/a');
	});
	test('garbage is named as garbage', () => {
		assert.throws(() => readHookInput('not json at all'), /hook input is not JSON/);
		assert.throws(() => readHookInput(''), /hook input is not JSON/);
		assert.throws(() => readHookInput('42'), /hook input is not JSON/);
	});
	// ⚠ THE KEYS RECEIVED ARE THE WHOLE DIAGNOSTIC. A hook wired to the wrong event sends a
	// well-formed payload with the wrong shape, and "no cwd" alone leaves nobody able to tell which
	// event actually fired.
	test('a payload with neither cwd nor a name lists the keys it did carry', () => {
		assert.throws(() => readHookInput('{"session_id":"s1","hook_event_name":"Stop"}'),
			/neither[\s\S]*session_id, hook_event_name/);
	});
});

// ---- readStdin's terminal guard --------------------------------------------------------------
//
// ⚠ MEASURED: `fs.readFileSync(0)` on a TTY does NOT come back empty, it BLOCKS — so `dt install
// --hook` typed at a prompt hung for ever with no output at all. `isTTY` is a parameter precisely
// so this is assertable without a pty.
describe('readStdin refuses a terminal rather than hanging on it', () => {
	test('a TTY stdin is named, not read', () => {
		assert.throws(() => readStdin(true), /--hook reads the harness's JSON on stdin — nothing is piped/);
	});
});

// ---- resolveNpm ------------------------------------------------------------------------------
//
// ⚠ EVERY BRANCH IS INJECTED. With `process.execPath` and `process.env` read directly there is no
// fixture that can make npm unresolvable — npm sits beside the node running this file — so the
// whole function, and the board line that depends on it, had no coverage at all.
describe('resolveNpm — beside the running node first, PATH second', () => {
	const dirs = [];
	const bin = (dir, name, mode = 0o755) => {
		fs.mkdirSync(dir, { recursive: true });
		const p = path.join(dir, name);
		fs.writeFileSync(p, '#!/bin/sh\nexit 0\n');
		fs.chmodSync(p, mode);
		return p;
	};
	const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-npm-')); dirs.push(d); return d; };

	test('npm BESIDE execPath wins, even when PATH also has one', () => {
		const beside = tmp(), onPath = tmp();
		const want = bin(beside, 'npm');
		bin(onPath, 'npm');
		assert.equal(resolveNpm(path.join(beside, 'node'), { PATH: onPath }), want);
	});
	test('not beside → the first PATH entry that has it', () => {
		const beside = tmp(), empty = tmp(), onPath = tmp();
		const want = bin(onPath, 'npm');
		assert.equal(resolveNpm(path.join(beside, 'node'), { PATH: [empty, onPath].join(path.delimiter) }), want);
	});
	test('neither → null', () => {
		assert.equal(resolveNpm(path.join(tmp(), 'node'), { PATH: tmp() }), null);
	});
	test('an empty or absent PATH is not an exception', () => {
		assert.equal(resolveNpm(path.join(tmp(), 'node'), {}), null);
		assert.equal(resolveNpm(path.join(tmp(), 'node'), { PATH: '' }), null);
	});
	// ⚠ PRESENT IS NOT RUNNABLE, and this path is SPAWNED. A non-executable file called `npm`
	// resolved fine under `existsSync` and then died as an EACCES nobody had planned a line for.
	test('a non-executable npm does not count as found', () => {
		const beside = tmp();
		bin(beside, 'npm', 0o644);
		assert.equal(resolveNpm(path.join(beside, 'node'), {}), null);
	});
	test('a DIRECTORY called npm does not count as found', () => {
		const beside = tmp();
		fs.mkdirSync(path.join(beside, 'npm'));
		assert.equal(resolveNpm(path.join(beside, 'node'), {}), null);
	});
});

// ---- the engine step's board line -------------------------------------------------------------
describe('the engine step says WHICH of node and npm is missing', () => {
	const step = [{ id: 'engine', label: 'engine: npm ci', state: 'todo' }];
	// The reason a step failed is `guard`'s, and `guard` reports on stderr — the board's own `log`
	// carries only the outcome line. Both halves are asserted, because either one alone leaves the
	// operator with a failure whose cause or whose consequence is missing.
	test('no npm anywhere → the §15 board line, and the step FAILS', () => {
		const said = [], erred = [];
		const err = console.error;
		console.error = (...a) => erred.push(a.join(' '));
		let code;
		try { code = applyInstall({ root: '/nowhere' }, {}, step, { npm: null, log: (l) => said.push(l), stdio: 'ignore' }); }
		finally { console.error = err; }
		assert.equal(code, 1);
		assert.ok(erred.includes('✖ engine: cannot install — node found, npm not on PATH'),
			`the board never named the missing npm:\n${erred.join('\n')}`);
		assert.ok(said.some((l) => l.includes('engine failed')), said.join('\n'));
	});
	test('a dry run resolves nothing and runs nothing', () => {
		const said = [];
		assert.equal(applyInstall({ root: '/nowhere' }, {}, step, { npm: null, dryRun: true, log: (l) => said.push(l) }), 0);
		assert.ok(!said.some((l) => l.includes('cannot install')), said.join('\n'));
	});
});
