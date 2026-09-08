// test/integration/install.test.js — tier 2: a real workspace, a real git worktree.
//
// `dt install` is the only verb whose whole job is a SIDE EFFECT on the checkout it runs in, so
// tier 1 cannot reach it: the plan is pure (test/unit/checkout.test.js) and everything below is
// about what actually lands on disk — a link, a compiled runtime, a subprocess, and a board that
// tells the truth about all three the second time it is run.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, git, dt, dtStdin } from '../helpers/ws.js';
import { observeState } from '../../src/checkout.js';

/** A linked worktree of a fixture workspace. Two things the fixture does NOT do for you and a
 *  worktree exposes: `workspace({pkg})` patches package.json WITHOUT committing it, and a worktree
 *  checks out HEAD — so commit first; and the fixture's node_modules is a real dir holding a
 *  `dreamteamer` SYMLINK to the engine, so mirror that one link (never the dir) so npm never runs. */
function linkedWorktree(ws, name = 'a') {
	git(ws.root, ['add', '-A']); git(ws.root, ['commit', '-qm', `fixture: ${name}`, '--allow-empty']);
	const dir = path.join(ws.root, '.worktrees', name);
	git(ws.root, ['worktree', 'add', '-b', `worktree-${name}`, dir, 'HEAD']);
	fs.mkdirSync(path.join(dir, 'node_modules'));
	fs.symlinkSync(fs.realpathSync(path.join(ws.root, 'node_modules', 'dreamteamer')), path.join(dir, 'node_modules', 'dreamteamer'));
	return dir;
}

describe('dt install in a linked worktree', () => {
	test('links .env from the primary, compiles, and a second run does nothing', () => {
		const ws = workspace();
		fs.writeFileSync(path.join(ws.root, '.env'), 'X=1\n');
		const wt = linkedWorktree(ws);
		const r1 = dt(wt, 'install');
		assert.equal(r1.code, 0, r1.stderr);
		assert.ok(fs.lstatSync(path.join(wt, '.env')).isSymbolicLink(), '.env should be a symlink');
		assert.ok(fs.existsSync(path.join(wt, '.dreamteamer', 'manifest.yaml')), 'compiled');
		const r2 = dt(wt, 'install');
		assert.equal(r2.code, 0);
		assert.doesNotMatch(r2.stdout, /▶/, 'second run must have no todo step');
		assert.match(r2.stdout, /\.env: linked to the primary/);
	});
	test('a worktree carrying its own .env is left alone', () => {
		const ws = workspace(); fs.writeFileSync(path.join(ws.root, '.env'), 'X=1\n');
		const wt = linkedWorktree(ws); fs.writeFileSync(path.join(wt, '.env'), 'X=2\n');
		assert.equal(dt(wt, 'install').code, 0);
		assert.ok(!fs.lstatSync(path.join(wt, '.env')).isSymbolicLink());
		assert.equal(fs.readFileSync(path.join(wt, '.env'), 'utf8'), 'X=2\n');
	});
	// ⚠ A DANGLING LINK IS WHAT A MOVED OR DELETED PRIMARY LEAVES BEHIND, and it is the one state
	// where "there is a symlink here" and "this checkout has a .env" disagree. Reporting it as
	// `✔ linked to the primary` would be the board lying about the file the whole verb exists to
	// place — so the observer reads a link as present only when it RESOLVES.
	test('a DANGLING .env link is replaced rather than reported as fine', () => {
		const ws = workspace();
		fs.writeFileSync(path.join(ws.root, '.env'), 'X=1\n');
		const wt = linkedWorktree(ws);
		fs.symlinkSync(path.join(wt, 'no-such-dir', '.env'), path.join(wt, '.env'));
		const r = dt(wt, 'install');
		assert.equal(r.code, 0, r.stderr);
		assert.match(r.stdout, /▶ \.env: link/);
		assert.doesNotMatch(r.stdout, /✔ \.env/);
		assert.equal(fs.readFileSync(path.join(wt, '.env'), 'utf8'), 'X=1\n');
	});
	// ⚠ `compile: false` in every asset fixture below, and it is not incidental: compile REFUSES a
	// `local-assets` entry that is not yet gitignored, and the fixture builder compiles before the
	// test body can write the `.gitignore` line. The worktree's own install compiles anyway.
	test('a declared local asset present in the primary is linked', () => {
		const ws = workspace({ compile: false, pkg: { 'local-assets': ['.profiles'] } });
		fs.mkdirSync(path.join(ws.root, '.profiles')); fs.appendFileSync(path.join(ws.root, '.gitignore'), '.profiles\n'); // no slash — see Task 4
		const wt = linkedWorktree(ws); // commits .gitignore and package.json before the worktree is cut
		assert.equal(dt(wt, 'install').code, 0);
		assert.ok(fs.lstatSync(path.join(wt, '.profiles')).isSymbolicLink());
	});
	// ⚠ TWO MODULES DECLARING THE SAME REL would otherwise produce two steps sharing one id, and
	// the second is silently dropped by any id-keyed lookup of the board.
	test('the same local asset declared twice yields ONE step', () => {
		const ws = workspace({ compile: false, pkg: { 'local-assets': ['.profiles', '.profiles'] } });
		fs.mkdirSync(path.join(ws.root, '.profiles')); fs.appendFileSync(path.join(ws.root, '.gitignore'), '.profiles\n');
		const wt = linkedWorktree(ws);
		const r = dt(wt, 'install');
		assert.equal(r.code, 0, r.stderr);
		assert.equal(r.stdout.match(/\.profiles:/g).length, 1, `\`.profiles\` planned twice:\n${r.stdout}`);
	});
	// ⚠ THE FIRST INSTALL IN A FRESH WORKTREE IS THE CASE THAT HAS TO PARSE, and it is also the one
	// with the most to say: compile logs its summary and the shelled-out steps write to whatever
	// handles they inherit. A `--json` that only parses on an already-settled checkout is not an
	// interface — so this run has real work in it (nothing is linked, nothing is compiled).
	test('--json is parseable on a run that HAS work to do', () => {
		const ws = workspace();
		fs.writeFileSync(path.join(ws.root, '.env'), 'X=1\n');
		const wt = linkedWorktree(ws);
		const r = dt(wt, 'install', '--json');
		assert.equal(r.code, 0, r.stderr);
		const payload = JSON.parse(r.stdout); // throws, loudly, if a single prose line escaped
		assert.equal(payload.code, 0);
		assert.equal(payload.checkout.kind, 'linked');
		assert.deepEqual(payload.steps.filter((s) => s.state === 'todo').map((s) => s.id), ['env', 'compile']);
		assert.match(r.stderr, /▶ \.env: link/, 'the board still reaches a human — on stderr');
		assert.ok(fs.lstatSync(path.join(wt, '.env')).isSymbolicLink(), '--json must APPLY, not plan');
	});
	// ⚠ A FAILING STEP'S EXIT CODE IS THE ONLY THING A CALLER CAN BRANCH ON. Without this case
	// `applyInstall`'s failure branch could be `return 0` and every other test here still passes.
	test('a failing step exits 1 and names itself, and the board is still printed', () => {
		const ws = workspace({ pkg: { postinstall: 'node -e "process.exit(3)"' } });
		const wt = linkedWorktree(ws);
		const r = dt(wt, 'install');
		assert.equal(r.code, 1, `a postinstall exiting 3 reported success:\n${r.stdout}`);
		assert.match(r.stdout, /✖ postinstall failed \(exit 3\)/);
		assert.match(r.stdout, /✔ engine/, 'the steps before the failure still ran');
	});
	// ⚠ AN EXECUTOR THAT THROWS ABANDONS THE REST OF THE PLAN — and under --json the payload with
	// it. fs throws on far more than a missing file, so the guard is the rule here, not the
	// exception: a file sitting where a link's parent directory has to go is one line of setup.
	test('a step that THROWS is reported as a failed step, and the plan continues', () => {
		const ws = workspace({ compile: false, pkg: { 'local-assets': ['nested/dir'] } });
		fs.mkdirSync(path.join(ws.root, 'nested', 'dir'), { recursive: true });
		fs.appendFileSync(path.join(ws.root, '.gitignore'), 'nested\n');
		const wt = linkedWorktree(ws);
		fs.writeFileSync(path.join(wt, 'nested'), 'a FILE where the parent directory has to go\n');
		const r = dt(wt, 'install');
		assert.equal(r.code, 1, `a failing link reported success:\n${r.stdout}`);
		assert.match(r.stderr, /✖ asset: /, 'the throw must be reported, not raised');
		assert.doesNotMatch(r.stderr, /^\s+at /m, 'a stack trace escaped to the operator');
		assert.match(r.stdout, /▶ compile/, 'the steps after the failure must still run');
		assert.ok(fs.existsSync(path.join(wt, '.dreamteamer', 'manifest.yaml')), 'compile was abandoned');
	});
	test('--dry-run prints the board and creates nothing', () => {
		const ws = workspace(); fs.writeFileSync(path.join(ws.root, '.env'), 'X=1\n');
		const wt = linkedWorktree(ws);
		const r = dt(wt, 'install', '--dry-run');
		assert.equal(r.code, 0); assert.match(r.stdout, /▶ \.env: link/);
		assert.ok(!fs.existsSync(path.join(wt, '.env')));
	});
	test('the primary never touches itself beyond compile', () => {
		const ws = workspace(); const before = git(ws.root, ['status', '--porcelain']);
		assert.equal(dt(ws.root, 'install').code, 0);
		assert.equal(git(ws.root, ['status', '--porcelain']), before);
	});
	test('a postinstall declaration runs LAST with DT_PRIMARY set', () => {
		const ws = workspace({ pkg: { postinstall: 'node -e "require(\'fs\').writeFileSync(\'post.txt\', process.env.DT_PRIMARY)"' } });
		const wt = linkedWorktree(ws);
		assert.equal(dt(wt, 'install').code, 0);
		assert.equal(fs.readFileSync(path.join(wt, 'post.txt'), 'utf8'), ws.root);
	});
});

// ⚠ THE OBSERVER IS WHAT MAKES `git modules: nothing to restore` TRUE, and it is the one step on the
// board whose result nobody eyeballs. Without the narrowing, a settled checkout prints
// `▶ git modules: restore <names>` for ever and the restore runs on every install. Both directions,
// through `observeState` directly — no clone is ever attempted, so nothing here reaches the network.
describe('observeState narrows git modules to the MISSING clones', () => {
	const declared = { 'git-modules': { widgets: { url: 'https://widgets.invalid/widgets.git', ref: 'main' } } };
	test('a declared clone that is absent is named', () => {
		const ws = workspace({ pkg: declared });
		assert.deepEqual(observeState(ws.ws).gitModules, ['widgets']);
	});
	test('a declared clone already on disk is NOT named', () => {
		const ws = workspace({ pkg: declared });
		fs.mkdirSync(path.join(ws.root, 'git_modules', 'widgets'), { recursive: true });
		assert.deepEqual(observeState(ws.ws).gitModules, []);
	});
});

// ⚠ A LOCAL ASSET DECLARATION IS NOT A LICENCE TO TOUCH THE REST OF THE DISK: `placeLink` writes
// wherever the rel points, so a rel that climbs out has to be refused before the board prints it.
describe('a local asset may not escape the workspace root', () => {
	test('a rel that climbs out is refused by name, and nothing is linked', () => {
		// compile: false — a rel that climbs out is refused by the COMPILER too now (Task 4); this
		// case is about the runtime refusal, which must not depend on the compiler having been run.
		const ws = workspace({ compile: false, pkg: { 'local-assets': ['../outside'] } });
		const wt = linkedWorktree(ws);
		const r = dt(wt, 'install');
		assert.equal(r.code, 1, `a rel outside the root was accepted:\n${r.stdout}`);
		assert.match(r.stderr, /resolves outside the workspace root/);
		assert.ok(!fs.existsSync(path.join(path.dirname(wt), 'outside')));
	});
});

describe('dt install refuses what a form cannot honour', () => {
	// ⚠ THE WORST INSTANCE: --dry-run's whole meaning is "do nothing", and the repos form used to
	// drop it and materialize for real.
	test('--dry-run on the repos form is refused rather than dropped', () => {
		const ws = workspace();
		const r = dt(ws.root, 'install', 'repos/x', '--dry-run');
		assert.equal(r.code, 1, `--dry-run was accepted and the repo form RAN:\n${r.stdout}`);
		assert.match(r.stderr, /--dry-run is not a flag of `dt install repos\/x`/);
		assert.match(r.stderr, /--all --json/);
	});
	test('--link-env on the repos form is refused', () => {
		const ws = workspace();
		const r = dt(ws.root, 'install', 'repos', '--link-env');
		assert.equal(r.code, 1);
		assert.match(r.stderr, /--link-env is not a flag of `dt install repos`/);
	});
	test('--all on the checkout form is refused', () => {
		const ws = workspace();
		const r = dt(ws.root, 'install', '--all');
		assert.equal(r.code, 1);
		assert.match(r.stderr, /--all is not a flag of `dt install`/);
	});
	// The muscle memory the retired `dt ensure <id>` taught: without this, the target is ignored
	// and a whole checkout install runs instead, reporting success for something else.
	test('a bare positional is refused and named with the repos spelling', () => {
		const ws = workspace();
		const r = dt(ws.root, 'install', 'widgets');
		assert.equal(r.code, 1, `the target was silently ignored:\n${r.stdout}`);
		assert.match(r.stderr, /takes no target "widgets"/);
		assert.match(r.stderr, /dt install repos\/widgets/);
	});
});

describe('dt install repos/<id> replaces ensure', () => {
	test('ensure is refused by name and points at install', () => {
		const ws = workspace();
		const r = dt(ws.root, 'ensure', 'repos/x');
		assert.equal(r.code, 2); assert.match(r.stderr, /ensure.*gone.*dt install repos\/<id>/s);
	});
	test('install repos/<id> reaches the materializer (a missing record is named)', () => {
		const ws = workspace();
		const r = dt(ws.root, 'install', 'repos/nope');
		assert.notEqual(r.code, 0); assert.match(r.stderr + r.stdout, /nope/);
	});
});

// ⚠ A SESSION HAS TO KNOW WHERE IT IS. Everything install decides turns on primary-vs-linked — .env
// is linked in one and not the other — and a linked worktree is otherwise indistinguishable from
// the primary by eye. `status` is the command run when something feels wrong, so it is where the
// answer belongs, together with the count of sibling worktrees holding work nobody can see from here.
describe('dt status reports the checkout and the worktrees', () => {
	test('status names the checkout kind and counts worktrees', () => {
		const ws = workspace();
		assert.equal(dt(ws.root, 'compile').code, 0);
		assert.equal(dt(ws.root, 'add', 'worktrees', '--name', 's').code, 0);

		const r = dt(ws.root, 'status');
		assert.equal(r.code, 0, r.stderr);
		assert.match(r.stdout, /checkout: primary/);
		assert.match(r.stdout, /worktrees: 1 · 0 with dirty records · 0 ahead/);

		const r2 = dt(path.join(ws.root, '.worktrees', 's'), 'status');
		assert.equal(r2.code, 0, r2.stderr);
		assert.match(r2.stdout, /checkout: linked worktree of /);
	});
});

// ---- the harness hook forms -----------------------------------------------------------------
//
// ⚠ A HOOK RUNS IN THE PRIMARY AND IS ABOUT THE WORKTREE. Claude Code's hook command resolves
// `$CLAUDE_PROJECT_DIR`, which the docs pin to the MAIN checkout even inside a worktree — so the
// process cwd is the primary and the only thing that says which checkout the session is actually
// in is the `cwd` field of the JSON on stdin. An `install --hook` that installed `process.cwd()`
// would report a green board for the wrong checkout, every time, and the worktree would open
// uncompiled with nobody told.
describe('dt install --hook installs the checkout named on STDIN', () => {
	test('it compiles and links the WORKTREE, not the cwd it was invoked from', () => {
		const ws = workspace();
		fs.writeFileSync(path.join(ws.root, '.env'), 'X=1\n');
		const wt = linkedWorktree(ws, 'a');
		fs.rmSync(path.join(wt, '.dreamteamer'), { recursive: true, force: true });

		const r = dtStdin(ws.root, JSON.stringify({ session_id: 's1', hook_event_name: 'SessionStart', cwd: wt }), 'install', '--hook');
		assert.equal(r.code, 0, r.stderr);
		assert.match(r.stdout, /linked worktree of /, 'the board is about the worktree');
		assert.ok(fs.existsSync(path.join(wt, '.dreamteamer', 'manifest.yaml')), 'the worktree was never compiled — the stdin cwd was ignored');
		assert.ok(fs.lstatSync(path.join(wt, '.env')).isSymbolicLink(), '.env was not linked into the worktree');
	});

	// §13.10 — the board becomes the session's context, so its LAST line is the landing instruction.
	test('the §13.10 landing line closes the board, verbatim', () => {
		const ws = workspace();
		const wt = linkedWorktree(ws, 'b');
		const r = dtStdin(ws.root, JSON.stringify({ cwd: wt }), 'install', '--hook');
		assert.equal(r.code, 0, r.stderr);
		assert.equal(r.stdout.trim().split('\n').at(-1),
			`this is worktree b of ${ws.root}; before you finish, dt commit your records and tell the operator to run dt land worktrees/b`);
	});

	test('in the PRIMARY there is nothing to land, so no landing line is printed', () => {
		const ws = workspace();
		const r = dtStdin(ws.root, JSON.stringify({ cwd: ws.root }), 'install', '--hook');
		assert.equal(r.code, 0, r.stderr);
		assert.match(r.stdout, /primary checkout/);
		assert.doesNotMatch(r.stdout, /this is worktree/);
	});

	// A WorktreeCreate payload piped into the SessionStart hook is well-formed and names the wrong
	// thing; without this it would install `process.cwd()` — the primary — and report success.
	test('a payload with a name but no cwd is refused, with the keys it did carry', () => {
		const ws = workspace();
		const r = dtStdin(ws.root, '{"name":"p"}', 'install', '--hook');
		assert.equal(r.code, 1, r.stdout);
		assert.match(r.stderr, /hook input carries no cwd/);
		assert.match(r.stderr, /keys received: name/);
	});

	test('garbage on stdin is named rather than silently installing the cwd', () => {
		const ws = workspace();
		const r = dtStdin(ws.root, 'not json', 'install', '--hook');
		assert.equal(r.code, 1, r.stdout);
		assert.match(r.stderr, /hook input is not JSON/);
	});
});

describe('dt install --print-adapters renders the harness snippet', () => {
	const CMD = 'sh "$CLAUDE_PROJECT_DIR/node_modules/dreamteamer/bin/dt-hook.sh"';

	test('stdout is JSON, and it is the three worktree-lifecycle hooks', () => {
		const ws = workspace();
		const r = dt(ws.root, 'install', '--print-adapters');
		assert.equal(r.code, 0, r.stderr);
		const snippet = JSON.parse(r.stdout);
		assert.deepEqual(Object.keys(snippet.hooks), ['SessionStart', 'WorktreeCreate', 'WorktreeRemove']);
		assert.equal(snippet.hooks.SessionStart[0].hooks[0].command, `${CMD} install --hook`);
		assert.equal(snippet.hooks.WorktreeCreate[0].hooks[0].command, `${CMD} add worktrees --hook`);
		assert.equal(snippet.hooks.WorktreeRemove[0].hooks[0].command, `${CMD} land --hook --dry-run`);
	});

	// §13.9 — bootstrap is idempotent precisely so the hook may fire on EVERY session event. A
	// `"matcher": "startup"` would silence it on resume, clear, compact and fork, which are most of
	// the events a long worktree session actually has.
	test('every hook carries timeout 600 and NO matcher', () => {
		const ws = workspace();
		const snippet = JSON.parse(dt(ws.root, 'install', '--print-adapters').stdout);
		for (const [event, entries] of Object.entries(snippet.hooks)) {
			for (const entry of entries) {
				assert.ok(!('matcher' in entry), `${event} carries a matcher`);
				for (const h of entry.hooks) {
					assert.equal(h.type, 'command');
					assert.equal(h.timeout, 600, `${event} has no 600s timeout`);
				}
			}
		}
	});

	// ⚠ NO ABSOLUTE MACHINE PATH IS EVER PRINTED. The snippet is committed into a harness settings
	// file that travels with the repo, so a path from THIS disk is a line that works on exactly one
	// machine — and the whole reason the command is `$CLAUDE_PROJECT_DIR`-relative.
	test('the snippet carries no path from this machine', () => {
		const ws = workspace();
		const out = dt(ws.root, 'install', '--print-adapters').stdout;
		assert.ok(out.includes('$CLAUDE_PROJECT_DIR'), out);
		assert.ok(!out.includes(ws.root), `the snippet named this checkout:\n${out}`);
		assert.doesNotMatch(out, /"[^"]*(?<!\$CLAUDE_PROJECT_DIR)\/(Users|home|private|opt|usr)\//);
	});

	test('a harness with no adapter says so, by name, and stdout stays parseable', () => {
		const ws = workspace({ compile: false, pkg: { harnesses: ['codex', 'claude-code'] } });
		const r = dt(ws.root, 'install', '--print-adapters');
		assert.equal(r.code, 0, r.stderr);
		assert.match(r.stderr, /codex: adapter not yet shipped \(decision 315\) — see using-dreamteamer › references\/worktrees\.md/);
		assert.ok(JSON.parse(r.stdout).hooks.SessionStart, 'the claude snippet must still be the whole of stdout');
	});

	test('--print-adapters plans nothing and installs nothing', () => {
		const ws = workspace();
		const wt = linkedWorktree(ws, 'c');
		fs.rmSync(path.join(wt, '.dreamteamer'), { recursive: true, force: true });
		assert.equal(dt(wt, 'install', '--print-adapters').code, 0);
		assert.ok(!fs.existsSync(path.join(wt, '.dreamteamer', 'manifest.yaml')), '--print-adapters ran the install');
	});

	// ⚠ EACH IS A FORM, so each refuses the OTHER forms' vocabulary. `--hook --dry-run` would
	// otherwise read as "plan the checkout named on stdin" — a thing this verb cannot do — and
	// `--print-adapters --json` as a board that is never produced.
	test('--hook refuses the checkout form\'s flags by name', () => {
		const ws = workspace();
		for (const flag of ['--dry-run', '--json', '--link-env']) {
			const r = dt(ws.root, 'install', '--hook', flag);
			assert.equal(r.code, 1, `${flag} was swallowed:\n${r.stdout}`);
			assert.match(r.stderr, new RegExp(`\\${flag} is not a flag of \`dt install --hook\``));
			assert.match(r.stderr, /that form takes --hook/);
		}
	});

	test('--print-adapters refuses the checkout form\'s flags by name', () => {
		const ws = workspace();
		for (const flag of ['--json', '--dry-run', '--link-env']) {
			const r = dt(ws.root, 'install', '--print-adapters', flag);
			assert.equal(r.code, 1, `${flag} was swallowed:\n${r.stdout}`);
			assert.match(r.stderr, new RegExp(`\\${flag} is not a flag of \`dt install --print-adapters\``));
		}
	});

	// ⚠ AN EMPTY RENDER AT EXIT 0 IS A DESTROYED FILE. `dt install --print-adapters > hooks.json` is
	// the way this output is used, and a workspace that never declared claude-code would have
	// truncated that file to nothing while reporting success.
	test('a workspace with no claude-code harness refuses rather than printing nothing', () => {
		const ws = workspace({ compile: false, pkg: { harnesses: ['codex', 'cursor'] } });
		const r = dt(ws.root, 'install', '--print-adapters');
		assert.equal(r.code, 1, `exit 0 with empty stdout truncates the file it is redirected into:\n${r.stdout}`);
		assert.equal(r.stdout.trim(), '');
		assert.match(r.stderr, /no claude-code harness declared — nothing to render/);
	});

	test('the two hook flags are refused on the repos form', () => {
		const ws = workspace();
		assert.match(dt(ws.root, 'install', 'repos', '--hook').stderr, /--hook is not a flag of `dt install repos`/);
		assert.match(dt(ws.root, 'install', 'repos', '--print-adapters').stderr, /--print-adapters is not a flag of `dt install repos`/);
	});
});
