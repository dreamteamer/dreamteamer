// test/integration/worktrees.test.js — tier 2: worktrees are OBSERVED, never stored.
//
// There is no `worktrees` collection and no record: `git worktree list` is the authority, and every
// row here is derived from it plus two cheap reads (dirty records, a compiled manifest). So the
// assertions below are all about the same thing — that the four verbs agree with git rather than
// with a state file that could drift from it.
//
// ⚠ THE REFUSALS ARE THE POINT of `rm`. A worktree holds uncommitted records and unlanded commits,
// and both are invisible from the primary — so removing one is the single most destructive thing in
// this verb set, and it refuses by default with the reason NAMED.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, git, dt } from '../helpers/ws.js';

/** The fixture commits BEFORE it compiles (`buildBase`), so CLAUDE.md/AGENTS.md/GEMINI.md are
 *  UNTRACKED in a fresh workspace — and a worktree's own install compiles them there too, leaving a
 *  tree that `rm` must refuse and `git worktree remove` refuses on its own. Committing them is what
 *  makes "a clean worktree" reachable at all. */
function commitHarness(root) {
	git(root, ['add', '-A']);
	git(root, ['commit', '-qm', 'fixture: compiled harness files', '--allow-empty']);
}

describe('worktrees are an observed entity', () => {
	test('list shows the primary alone on a fresh workspace', () => {
		const ws = workspace();
		const r = dt(ws.root, 'list', 'worktrees', '--json');
		assert.equal(r.code, 0, r.stderr);
		const rows = JSON.parse(r.stdout);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].primary, true);
	});

	test('add creates the worktree on branch worktree-<name>, installs it, prints its path last; list and get see it', () => {
		const ws = workspace();
		fs.writeFileSync(path.join(ws.root, '.env'), 'X=1\n');
		const r = dt(ws.root, 'add', 'worktrees', '--name', 'probe');
		assert.equal(r.code, 0, r.stderr);
		const dir = r.stdout.trim().split('\n').at(-1);
		assert.equal(dir, path.join(ws.root, '.worktrees', 'probe'));
		assert.equal(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'worktree-probe');
		assert.ok(fs.existsSync(path.join(dir, '.dreamteamer', 'manifest.yaml')), 'installed (compiled)');
		assert.ok(fs.lstatSync(path.join(dir, '.env')).isSymbolicLink(), '.env linked from the primary');

		const g = JSON.parse(dt(ws.root, 'get', 'worktrees/probe', '--json').stdout);
		assert.equal(g.branch, 'worktree-probe');
		assert.equal(g.bootstrapped, true);
		assert.equal(g.ahead, 0);
		assert.ok(JSON.parse(dt(ws.root, 'list', 'worktrees', '--json').stdout).some((w) => w.name === 'probe'));
	});

	test('add refuses a name that already exists', () => {
		const ws = workspace();
		assert.equal(dt(ws.root, 'add', 'worktrees', '--name', 'p').code, 0);
		const r = dt(ws.root, 'add', 'worktrees', '--name', 'p');
		assert.notEqual(r.code, 0);
		assert.match(r.stderr, /already exists/);
	});

	// ⚠ INSIDE the root, not the OS temp dir: the credentials rule links `.env` only for a worktree
	// under the primary root, and on macOS /var resolves to /private/var while git records the
	// realpath — so a tmpdir sandbox would compare unequal to its own row in `git worktree list`.
	test('add --temp is detached, lands under .worktrees/.tmp-*, and is listed', () => {
		const ws = workspace();
		const r = dt(ws.root, 'add', 'worktrees', '--name', 't', '--temp');
		assert.equal(r.code, 0, r.stderr);
		const dir = r.stdout.trim().split('\n').at(-1);
		assert.match(dir, new RegExp(`^${ws.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.worktrees/\\.tmp-`));
		assert.equal(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD');
		assert.equal(git(ws.root, ['branch', '--list', 'worktree-t']), '', '--temp must not create a branch');
		assert.ok(JSON.parse(dt(ws.root, 'list', 'worktrees', '--json').stdout).some((w) => w.path === dir && w.branch === null));
		dt(ws.root, 'rm', `worktrees/${dir}`, '--force');
	});

	test('rm refuses a worktree with a dirty record and names it; --force removes', () => {
		const ws = workspace();
		assert.equal(dt(ws.root, 'add', 'worktrees', '--name', 'd').code, 0);
		const dir = path.join(ws.root, '.worktrees', 'd');
		fs.mkdirSync(path.join(dir, 'data'), { recursive: true }); // data/ is EMPTY in the fixture and so absent in a checkout
		fs.writeFileSync(path.join(dir, 'data', 'stray.md'), 'x');

		const r = dt(ws.root, 'rm', 'worktrees/d');
		assert.notEqual(r.code, 0);
		assert.match(r.stderr, /1 dirty record/);
		assert.ok(fs.existsSync(dir), 'the refusal removed it anyway');
		assert.equal(dt(ws.root, 'rm', 'worktrees/d', '--force').code, 0);
		assert.ok(!fs.existsSync(dir));
	});

	test('rm refuses a branch with unlanded commits', () => {
		const ws = workspace();
		assert.equal(dt(ws.root, 'add', 'worktrees', '--name', 'u').code, 0);
		const dir = path.join(ws.root, '.worktrees', 'u');
		fs.writeFileSync(path.join(dir, 'note.txt'), 'x');
		git(dir, ['add', 'note.txt']);
		git(dir, ['commit', '-qm', 'note']);

		const r = dt(ws.root, 'rm', 'worktrees/u');
		assert.notEqual(r.code, 0);
		assert.match(r.stderr, /1 commit\(s\) not on/);
		assert.ok(fs.existsSync(dir));
	});

	// The happy path, and the only one that proves the refusals are not simply "rm never works".
	test('a clean, INSTALLED worktree is removed without --force, and its branch goes with it', () => {
		const ws = workspace();
		commitHarness(ws.root);
		assert.equal(dt(ws.root, 'add', 'worktrees', '--name', 'c').code, 0);
		const dir = path.join(ws.root, '.worktrees', 'c');
		assert.ok(fs.existsSync(path.join(dir, '.dreamteamer', 'manifest.yaml')), 'fixture: it should be installed');

		const r = dt(ws.root, 'rm', 'worktrees/c');
		assert.equal(r.code, 0, r.stderr);
		assert.ok(!fs.existsSync(dir));
		assert.equal(git(ws.root, ['branch', '--list', 'worktree-c']), '', 'the branch outlived the worktree');
	});

	test('rm refuses the primary checkout', () => {
		const ws = workspace();
		const r = dt(ws.root, 'rm', `worktrees/${ws.root}`, '--force');
		assert.notEqual(r.code, 0);
		assert.match(r.stderr, /primary checkout/);
	});

	// ⚠ A DETACHED worktree has no branch, so `rev-list <primary>..<branch>` has nothing to count.
	// Reading `ahead` off a null branch is the crash this pins — and `git worktree add --detach` is
	// how anyone bisects, so it is not an exotic state.
	test('a detached worktree lists with branch null and ahead null — never a crash', () => {
		const ws = workspace();
		const dir = path.join(ws.root, '.worktrees', 'det');
		git(ws.root, ['worktree', 'add', '--detach', dir, 'HEAD']);
		const r = dt(ws.root, 'list', 'worktrees', '--json');
		assert.equal(r.code, 0, r.stderr);
		const row = JSON.parse(r.stdout).find((w) => w.path === dir);
		assert.ok(row, `no row for ${dir}`);
		assert.equal(row.branch, null);
		assert.equal(row.ahead, null);
	});

	// ⚠ THE FLAG TABLE IS NOT OPTIONAL. `refuseUnknownFlags` lives inside `collectionCommand`, which
	// the `worktrees` intercept never reaches — so without a table entry and an explicit call,
	// `--tmep` is swallowed and a SANDBOX request silently becomes a permanent branch worktree.
	test('a mistyped flag on `add worktrees` is refused, names the flag it meant, and creates nothing', () => {
		const ws = workspace();
		const r = dt(ws.root, 'add', 'worktrees', '--name', 'x', '--tmep');
		assert.equal(r.code, 1, `--tmep was accepted:\n${r.stdout}`);
		assert.match(r.stderr, /unknown flag "--tmep"/);
		assert.match(r.stderr, /did you mean --temp\?/);
		assert.ok(!fs.existsSync(path.join(ws.root, '.worktrees')), 'a worktree was created anyway');
		assert.equal(git(ws.root, ['branch', '--list', 'worktree-x']), '', 'a branch was created anyway');
	});

	test('a verb worktrees do not have says which four they do', () => {
		const ws = workspace();
		const r = dt(ws.root, 'history', 'worktrees/probe');
		assert.equal(r.code, 1);
		assert.match(r.stderr, /list · get · add · rm/);
	});
});
