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

	// ⚠ `--path` WOULD BE ACCEPTED AND IGNORED: --temp places the sandbox itself, so the directory
	// asked for is silently not the directory made. Same class as --tmep, one flag further in.
	test('--temp and --path together are refused rather than one being ignored', () => {
		const ws = workspace();
		const r = dt(ws.root, 'add', 'worktrees', '--name', 't', '--temp', '--path', 'elsewhere');
		assert.equal(r.code, 1, `--path was ignored:\n${r.stdout}`);
		assert.match(r.stderr, /--temp places the sandbox itself/);
		assert.ok(!fs.existsSync(path.join(ws.root, '.worktrees')));
	});

	// Found by walking the flow: git keeps listing a worktree whose directory was deleted by hand,
	// and reading its dirty state there died as `✖ spawnSync git ENOENT` — a message about the
	// wrong thing entirely, on the one state where removing the registration is perfectly safe.
	test('rm names a worktree whose directory is GONE instead of failing in git', () => {
		const ws = workspace();
		assert.equal(dt(ws.root, 'add', 'worktrees', '--name', 'g').code, 0);
		fs.rmSync(path.join(ws.root, '.worktrees', 'g'), { recursive: true, force: true });

		assert.equal(dt(ws.root, 'list', 'worktrees', '--json').code, 0, 'list must survive it too');
		const r = dt(ws.root, 'rm', 'worktrees/g');
		assert.equal(r.code, 1);
		assert.match(r.stderr, /its directory is gone/);
		assert.doesNotMatch(r.stderr, /ENOENT/);
		assert.equal(dt(ws.root, 'rm', 'worktrees/g', '--force').code, 0);
		assert.equal(git(ws.root, ['worktree', 'list', '--porcelain']).match(/\/g$/m), null, 'the registration outlived --force');
	});

	// ⚠ THE DATA-LOSS PATH, and the sandbox verb makes it the ordinary one. `ahead` is null for a
	// DETACHED worktree by construction, and `git worktree remove` checks only modified and
	// untracked files — never reachability. So a --temp sandbox whose work was committed read as
	// clean-and-nothing-ahead and went at exit 0, orphaning every commit the moment its HEAD reflog
	// went with it. Detached or not, the COUNT is what matters; only the fix differs.
	test('rm refuses a DETACHED worktree holding commits, and names the sha because no branch does', () => {
		const ws = workspace();
		commitHarness(ws.root); // so the tree is CLEAN and the ahead check is the only thing left
		const r = dt(ws.root, 'add', 'worktrees', '--name', 's', '--temp');
		assert.equal(r.code, 0, r.stderr);
		const dir = r.stdout.trim().split('\n').at(-1);
		fs.writeFileSync(path.join(dir, 'note.txt'), 'x');
		git(dir, ['add', 'note.txt']);
		git(dir, ['commit', '-qm', 'sandbox work']);
		const head = git(dir, ['rev-parse', 'HEAD']).slice(0, 7);

		const rm = dt(ws.root, 'rm', `worktrees/${dir}`);
		assert.notEqual(rm.code, 0, `THE COMMITS WERE ORPHANED:\n${rm.stdout}`);
		assert.match(rm.stderr, /1 commit\(s\) reachable from NOTHING but this worktree/);
		assert.match(rm.stderr, new RegExp(head), 'no branch names them, so the sha must');
		assert.ok(fs.existsSync(dir), 'the refusal removed it anyway');

		// ⚠ AND DOING WHAT THE MESSAGE SAYS HAS TO WORK. The danger in a detached worktree is that
		// the commits are reachable from NOTHING but its HEAD — so once a branch holds them they are
		// safe, and a refusal that still fired would be a message whose own instruction is a lie.
		git(ws.root, ['branch', 'kept-work', head]);
		const after = dt(ws.root, 'rm', `worktrees/${dir}`);
		assert.equal(after.code, 0, `the message said to keep them with a branch, and it did not help:\n${after.stderr}`);
		assert.match(git(ws.root, ['log', '--oneline', '-1', 'kept-work']), /sandbox work/, 'the work must survive');
	});

	// `--path` lets the directory basename differ from the name that was typed, and the name is what
	// `get`, the duplicate guard and the branch cleanup all have to key on — otherwise the name just
	// typed finds nothing, and `rm` leaves branch worktree-<n> behind while reporting success.
	test('--path places the worktree elsewhere and the NAME still addresses it everywhere', () => {
		const ws = workspace();
		commitHarness(ws.root);
		const r = dt(ws.root, 'add', 'worktrees', '--name', 'n', '--path', 'elsewhere/tree');
		assert.equal(r.code, 0, r.stderr);
		const dir = r.stdout.trim().split('\n').at(-1);
		assert.equal(dir, path.join(ws.root, 'elsewhere', 'tree'));

		const g = dt(ws.root, 'get', 'worktrees/n', '--json');
		assert.equal(g.code, 0, g.stderr);
		assert.equal(JSON.parse(g.stdout).path, dir);

		const again = dt(ws.root, 'add', 'worktrees', '--name', 'n');
		assert.notEqual(again.code, 0);
		assert.match(again.stderr, /worktree "n" already exists/, 'the duplicate guard could not see it');

		const rm = dt(ws.root, 'rm', 'worktrees/n');
		assert.equal(rm.code, 0, rm.stderr);
		assert.ok(!fs.existsSync(dir));
		assert.equal(git(ws.root, ['branch', '--list', 'worktree-n']), '', 'a stale branch outlived the worktree');
	});

	// The random holder exists so that sandboxes can share a name; refusing the second one would
	// half-defeat it. Which makes the NAME ambiguous — so it is refused rather than resolved to
	// whichever row git happened to list first.
	test('two --temp sandboxes coexist under one name, and the ambiguous name is refused', () => {
		const ws = workspace();
		const a = dt(ws.root, 'add', 'worktrees', '--name', 's', '--temp');
		assert.equal(a.code, 0, a.stderr);
		const b = dt(ws.root, 'add', 'worktrees', '--name', 's', '--temp');
		assert.equal(b.code, 0, b.stderr);
		const [da, db] = [a, b].map((r) => r.stdout.trim().split('\n').at(-1));
		assert.notEqual(da, db);
		assert.equal(JSON.parse(dt(ws.root, 'list', 'worktrees', '--json').stdout).filter((w) => w.name === 's').length, 2);

		const g = dt(ws.root, 'get', 'worktrees/s');
		assert.equal(g.code, 1, `one of two was picked silently:\n${g.stdout}`);
		assert.match(g.stderr, /names 2 worktrees/);
		assert.equal(dt(ws.root, 'rm', `worktrees/${da}`, '--force').code, 0);
		assert.equal(dt(ws.root, 'rm', `worktrees/${db}`, '--force').code, 0);
	});

	test('the .tmp-<rand> holder goes with the sandbox it held', () => {
		const ws = workspace();
		const r = dt(ws.root, 'add', 'worktrees', '--name', 's', '--temp');
		assert.equal(r.code, 0, r.stderr);
		const dir = r.stdout.trim().split('\n').at(-1);
		const holder = path.dirname(dir);
		assert.ok(fs.existsSync(holder), 'fixture: the holder should be there first');
		assert.equal(dt(ws.root, 'rm', `worktrees/${dir}`, '--force').code, 0);
		assert.ok(!fs.existsSync(holder), 'an empty .tmp- holder was left behind for ever');
	});

	// ⚠ git's REASON is in its stderr, which this engine pipes — so a failure used to be reported as
	// the command line and nothing else. A locked worktree is the everyday case (tooling locks the
	// ones it creates) and "locked" is the one word that explains the refusal.
	test('a git failure carries git own reason — a LOCKED worktree says it is locked', () => {
		const ws = workspace();
		commitHarness(ws.root);
		assert.equal(dt(ws.root, 'add', 'worktrees', '--name', 'l').code, 0);
		const dir = path.join(ws.root, '.worktrees', 'l');
		git(ws.root, ['worktree', 'lock', dir]);

		const r = dt(ws.root, 'rm', 'worktrees/l');
		assert.equal(r.code, 1);
		assert.match(r.stderr, /locked/i, `git's reason was dropped:\n${r.stderr}`);
		// and it is the HEADLINE: every summary in checkout.js reads message.split('\n')[0], so a
		// reason sitting behind "Command failed: git worktree remove <path>" is a reason that
		// vanishes wherever the message is summarised to one line.
		assert.doesNotMatch(r.stderr, /^✖ Command failed/, `the command line led and the reason followed:\n${r.stderr}`);
		assert.ok(fs.existsSync(dir));
		git(ws.root, ['worktree', 'unlock', dir]);
	});

	test('rm SAYS which branch it kept when it is not the one this verb creates', () => {
		const ws = workspace();
		commitHarness(ws.root);
		const dir = path.join(ws.root, '.worktrees', 'own');
		git(ws.root, ['branch', 'feature-x']);
		git(ws.root, ['worktree', 'add', dir, 'feature-x']);

		const r = dt(ws.root, 'rm', `worktrees/${dir}`);
		assert.equal(r.code, 0, r.stderr);
		assert.match(r.stdout, /branch feature-x kept/);
		assert.match(git(ws.root, ['branch', '--list', 'feature-x']), /feature-x/, 'a branch this verb did not create must survive');
	});

	test('a verb worktrees do not have says which four they do', () => {
		const ws = workspace();
		const r = dt(ws.root, 'history', 'worktrees/probe');
		assert.equal(r.code, 1);
		assert.match(r.stderr, /list · get · add · rm/);
	});
});
