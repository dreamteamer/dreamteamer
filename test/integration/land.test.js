// test/integration/land.test.js — tier 2: `dt land` is the ONE movement verb, and every assertion
// here is about what it does to a DISK.
//
// ⚠ THE REFUSALS AND THE ABORT ARE THE POINT. A landing rewrites the primary branch and deletes a
// worktree; when it cannot do that cleanly the contract is not "do something reasonable", it is
// "leave every tree exactly as it was and say why". So most of this file measures the NON-landing
// paths — and each of those tests snapshots both checkouts before and asserts them identical after,
// because "it printed a refusal" and "it changed nothing" are two different claims.
//
// The rebase runs on a COPY (`land/<name>`) in a throwaway detached worktree, so even the worktree
// branch's hashes survive a conflict. That is what makes the byte-identical claim testable at all.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, git, dt, dtStdin } from '../helpers/ws.js';

/** The fixture commits BEFORE it compiles (`buildBase`), so CLAUDE.md/AGENTS.md/GEMINI.md are
 *  UNTRACKED in a fresh workspace — and a worktree's own install compiles them there too, leaving a
 *  tree that `land` must refuse. Committing them is what makes "a clean worktree" reachable. */
function commitHarness(root) {
	git(root, ['add', '-A']);
	git(root, ['commit', '-qm', 'fixture: compiled harness files', '--allow-empty']);
}

/** A primary with its harness committed and one linked worktree `a`, ready to be landed. */
function landable(opts = {}) {
	const ws = workspace(opts);
	commitHarness(ws.root);
	const r = dt(ws.root, 'add', 'worktrees', '--name', 'a');
	assert.equal(r.code, 0, r.stderr);
	const wt = path.join(ws.root, '.worktrees', 'a');
	const primaryBranch = git(ws.root, ['rev-parse', '--abbrev-ref', 'HEAD']);
	return { ...ws, wt, primaryBranch, land: (...a) => dt(ws.root, 'land', ...a) };
}

/** `dt add notes --title <t>` → the workspace-relative path it printed. The id carries TODAY's
 *  date, so the path is read back rather than spelled here. */
function addNote(root, title) {
	const r = dt(root, 'add', 'notes', '--title', title);
	assert.equal(r.code, 0, r.stderr);
	return r.stdout.trim().split(/\s+/).pop();
}

function addAndCommit(root, title) {
	const rel = addNote(root, title);
	assert.equal(dt(root, 'commit').code, 0);
	return rel;
}

/** Everything a refusal promises not to touch. Compared whole, so a test never has to enumerate
 *  which half of the pair moved. */
const snapshot = (ws) => ({
	primaryHead: git(ws.root, ['rev-parse', 'HEAD']),
	primaryStatus: git(ws.root, ['status', '--porcelain']),
	worktreeHead: fs.existsSync(ws.wt) ? git(ws.wt, ['rev-parse', 'HEAD']) : null,
	worktreeStatus: fs.existsSync(ws.wt) ? git(ws.wt, ['status', '--porcelain']) : null,
	branches: git(ws.root, ['branch', '--list']),
});

const landHolders = (root) => fs.existsSync(path.join(root, '.worktrees'))
	? fs.readdirSync(path.join(root, '.worktrees')).filter((d) => d.startsWith('.land-'))
	: [];

const compiledAt = (root) => /^compiled:\s*(\S+)/m.exec(fs.readFileSync(path.join(root, '.dreamteamer', 'manifest.yaml'), 'utf8'))?.[1];

describe('dt land — the happy path', () => {
	test('one committed record lands, the primary recompiles, and the worktree and both branches are retired', () => {
		const ws = landable();
		const rel = addAndCommit(ws.wt, 'first note');
		const landedSha = git(ws.wt, ['rev-parse', 'HEAD']);
		const subject = git(ws.wt, ['log', '-1', '--format=%s']);
		const before = compiledAt(ws.root);

		const r = ws.land('worktrees/a');
		assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
		assert.ok(fs.existsSync(path.join(ws.root, rel)), `the record did not reach the primary: ${rel}`);
		assert.equal(git(ws.root, ['rev-parse', 'HEAD']), landedSha, 'the primary is not on the worktree commit');
		assert.equal(git(ws.root, ['log', '-1', '--format=%s']), subject);
		assert.match(r.stdout, new RegExp(`✔ landed worktrees/a onto ${ws.primaryBranch}: 1 commit`));
		assert.match(r.stdout, /notes: 1 record/);
		assert.ok(!fs.existsSync(ws.wt), 'the worktree directory is still there');
		assert.equal(git(ws.root, ['branch', '--list', 'worktree-a']), '', 'worktree-a survived');
		assert.equal(git(ws.root, ['branch', '--list', 'land/a']), '', 'land/a survived');
		assert.deepEqual(landHolders(ws.root), [], 'a .land-* holder was left behind');
		assert.ok(compiledAt(ws.root) > before, 'the primary was not recompiled');
	});
});

describe('dt land — the preconditions, each refused by name and each changing nothing', () => {
	test('a PENDING record write in the primary is refused — a landing would sweep it into this subject', () => {
		const ws = landable();
		addAndCommit(ws.wt, 'first note');
		addNote(ws.root, 'someone elses pending note'); // written, NOT committed
		const before = snapshot(ws);

		const r = ws.land('worktrees/a');
		assert.equal(r.code, 1, r.stdout);
		assert.match(r.stderr, /the primary has 1 pending record write\(s\) — dt commit them first/);
		assert.deepEqual(snapshot(ws), before);
	});

	test('a dirty record in the worktree is refused with the count and the fix', () => {
		const ws = landable();
		addAndCommit(ws.wt, 'first note');
		addNote(ws.wt, 'second note'); // written, NOT committed
		const before = snapshot(ws);

		const r = ws.land('worktrees/a');
		assert.equal(r.code, 1, r.stdout);
		assert.match(r.stderr, /1 dirty record\(s\) — dt commit them first/);
		assert.deepEqual(snapshot(ws), before);
	});

	test('a DETACHED worktree is refused with the two commands that fix it — and --branch does the first one', () => {
		const ws = landable();
		addAndCommit(ws.wt, 'first note');
		// A worktree is detached the way anyone bisects. The branch is deleted too, or `--branch a`
		// below would collide with the very branch this fixture is pretending never existed.
		git(ws.wt, ['switch', '--detach']);
		git(ws.root, ['branch', '-D', 'worktree-a']);
		const before = snapshot(ws);

		const r = ws.land('worktrees/a');
		assert.equal(r.code, 1, r.stdout);
		assert.match(r.stderr, /it is DETACHED \(no branch\) — inside it: git switch -c worktree-a/);
		assert.deepEqual(snapshot(ws), before);

		const r2 = ws.land('worktrees/a', '--branch', 'a');
		assert.equal(r2.code, 0, `${r2.stdout}\n${r2.stderr}`);
		assert.equal(git(ws.root, ['rev-parse', 'HEAD']), before.worktreeHead);
	});

	test('a branch with an UPSTREAM is refused — a pushed branch is not rebased', () => {
		const ws = landable();
		addAndCommit(ws.wt, 'first note');
		const remote = path.join(path.dirname(ws.root), `remote-${path.basename(ws.root)}.git`);
		git(ws.root, ['init', '--bare', '-q', remote]);
		git(ws.root, ['remote', 'add', 'origin', remote]);
		git(ws.root, ['push', '-q', 'origin', 'worktree-a']);
		git(ws.root, ['branch', '--set-upstream-to=origin/worktree-a', 'worktree-a']);
		const before = snapshot(ws);

		const r = ws.land('worktrees/a');
		assert.equal(r.code, 1, r.stdout);
		assert.match(r.stderr, /branch worktree-a has an upstream \(origin\/worktree-a\) — a pushed branch is not rebased/);
		assert.deepEqual(snapshot(ws), before);
		fs.rmSync(remote, { recursive: true, force: true });
	});

	test('a worktree with nothing ahead is refused rather than landing an empty range', () => {
		const ws = landable();
		const before = snapshot(ws);

		const r = ws.land('worktrees/a');
		assert.equal(r.code, 1, r.stdout);
		assert.match(r.stderr, new RegExp(`nothing to land — worktree-a is already on ${ws.primaryBranch}`));
		assert.deepEqual(snapshot(ws), before);
	});

	test('a LIVE land holds the lock and the second one waits; a dead pid is reclaimed and the land proceeds', () => {
		const ws = landable();
		addAndCommit(ws.wt, 'first note');
		const lock = path.join(ws.root, '.git', 'dreamteamer-land.lock');
		fs.mkdirSync(lock, { recursive: true });
		fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
		const before = snapshot(ws);

		const held = ws.land('worktrees/a');
		assert.equal(held.code, 1, held.stdout);
		assert.match(held.stderr, new RegExp(`another land holds the lock \\(pid ${process.pid}, \\d+[sm]\\)`));
		assert.deepEqual(snapshot(ws), before);

		// A pid that cannot be signalled is a land that died — the lock is reclaimed, out loud.
		fs.writeFileSync(path.join(lock, 'pid'), '999999');
		const r = ws.land('worktrees/a');
		assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
		assert.match(r.stdout, /reclaimed .*dreamteamer-land\.lock — pid 999999 is gone/);
		assert.ok(!fs.existsSync(lock), 'the lock was not released');
	});
});

describe('dt land — the conflict classes', () => {
	test('a RECORDS conflict aborts, names the paths by collection, and leaves every tree byte-identical', () => {
		// The record has to exist on BOTH sides, so it is committed BEFORE the worktree is cut.
		const ws = workspace();
		const rel = addAndCommit(ws.root, 'shared note');
		commitHarness(ws.root);
		assert.equal(dt(ws.root, 'add', 'worktrees', '--name', 'a').code, 0);
		const wt = path.join(ws.root, '.worktrees', 'a');
		const id = path.basename(rel).replace('.note.md', '');
		const primaryBranch = git(ws.root, ['rev-parse', '--abbrev-ref', 'HEAD']);
		for (const [root, body] of [[wt, 'written in the worktree'], [ws.root, 'written in the primary']]) {
			assert.equal(dt(root, 'set', `notes/${id}`, `body=${body}`).code, 0);
			assert.equal(dt(root, 'commit').code, 0);
		}
		const fixture = { root: ws.root, wt };
		const before = snapshot(fixture);

		const r = dt(ws.root, 'land', 'worktrees/a');
		assert.equal(r.code, 1, r.stdout);
		assert.match(r.stderr, new RegExp(`✖ landing worktrees/a conflicts with ${primaryBranch} at commit [0-9a-f]{7} `));
		assert.match(r.stderr, new RegExp(`  notes: ${rel}`));
		assert.match(r.stderr, /both trees are exactly as before/);
		assert.deepEqual(snapshot(fixture), before, 'the abort moved something');
		assert.equal(git(ws.root, ['branch', '--list', 'land/a']), '', 'the copy branch survived the abort');
		assert.deepEqual(landHolders(ws.root), [], 'a .land-* holder was left behind');
	});

	test('a MANAGED-BLOCK conflict is resolved by regenerating the block, and the landing continues', () => {
		// ⚠ TWO REAL SYSTEM WRITES, and their names are adjacent ON PURPOSE. Measured: two
		// `add collections` on distant names merge cleanly (the block's lines are far apart), and two
		// `add-field` calls on the SAME collection conflict in the DESCRIPTOR as well, which is a
		// records-row conflict. Adjacent new collections are the shape that conflicts in the
		// orientation block and NOWHERE else — the case this whole resolution exists for.
		const ws = landable();
		assert.equal(dt(ws.wt, 'add', 'collections', '--name', 'alpha').code, 0);
		assert.equal(dt(ws.root, 'add', 'collections', '--name', 'alphb').code, 0);

		const r = ws.land('worktrees/a');
		assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
		assert.match(r.stdout, /managed block regenerated: .*CLAUDE\.md/);
		// The landed block is the one a compile at this tip produces — not either side's copy.
		assert.equal(dt(ws.root, 'compile').code, 0);
		assert.equal(git(ws.root, ['status', '--porcelain', '--', 'CLAUDE.md']), '', 'the landed CLAUDE.md is not what compile produces');
		assert.match(fs.readFileSync(path.join(ws.root, 'CLAUDE.md'), 'utf8'), /- alpha\b/);
		assert.match(fs.readFileSync(path.join(ws.root, 'CLAUDE.md'), 'utf8'), /- alphb\b/);
	});

	test('a conflict OUTSIDE the block in a managed file is a records-row conflict — the prose is never discarded', () => {
		const ws = workspace();
		// The fixture's CLAUDE.md is block-and-nothing-else, so the operator's own prose is added
		// above it first — that is what makes an outside-the-block hunk possible at all.
		const claude = path.join(ws.root, 'CLAUDE.md');
		fs.writeFileSync(claude, `# house rules\nthe original line\n\n${fs.readFileSync(claude, 'utf8')}`);
		commitHarness(ws.root);
		assert.equal(dt(ws.root, 'add', 'worktrees', '--name', 'a').code, 0);
		const wt = path.join(ws.root, '.worktrees', 'a');
		const edit = (root, line) => {
			const f = path.join(root, 'CLAUDE.md');
			fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('the original line', line));
			git(root, ['commit', '-qm', 'rules', '--', 'CLAUDE.md']);
		};
		edit(wt, 'the worktree line');
		edit(ws.root, 'the primary line');
		const fixture = { root: ws.root, wt };
		const before = snapshot(fixture);

		const r = dt(ws.root, 'land', 'worktrees/a');
		assert.equal(r.code, 1, r.stdout);
		assert.match(r.stderr, /other files: CLAUDE\.md/);
		assert.deepEqual(snapshot(fixture), before);
		assert.match(fs.readFileSync(claude, 'utf8'), /the primary line/, 'the hand-written prose was discarded');
	});
});

describe('dt land — the copy is kept when the rebased tree does not check', () => {
	test('a schema violation in the range stops the landing and says the branch is rebased but NOT landed', () => {
		const ws = landable();
		// A record git will carry and `check` will refuse: a valid id, no `title`.
		const bad = path.join(ws.wt, 'data', 'notes', '2026-01-01--broken.note.md');
		fs.mkdirSync(path.dirname(bad), { recursive: true });
		fs.writeFileSync(bad, '---\nbody: no title anywhere\n---\n\nnothing\n');
		git(ws.wt, ['add', '--', 'data/notes/2026-01-01--broken.note.md']);
		git(ws.wt, ['commit', '-qm', 'a record that does not validate']);
		const before = snapshot(ws);

		const r = ws.land('worktrees/a');
		assert.equal(r.code, 1, r.stdout);
		assert.match(r.stderr, /rebased as land\/a but NOT landed — dt check failed on the rebased tree; inspect with git log land\/a/);
		assert.notEqual(git(ws.root, ['branch', '--list', 'land/a']), '', 'the rebased copy was deleted with the report');
		assert.equal(git(ws.root, ['rev-parse', 'HEAD']), before.primaryHead);
		assert.equal(git(ws.wt, ['rev-parse', 'HEAD']), before.worktreeHead);
		assert.deepEqual(landHolders(ws.root), [], 'a .land-* holder was left behind');
	});
});

describe('dt land --dry-run mutates nothing', () => {
	test('a landable worktree prints the steps and exits 0, and both trees are untouched', () => {
		const ws = landable();
		addAndCommit(ws.wt, 'first note');
		const before = snapshot(ws);

		const r = ws.land('worktrees/a', '--dry-run');
		assert.equal(r.code, 0, r.stderr);
		assert.match(r.stdout, /rebase/);
		assert.match(r.stdout, /1 commit · 1 record file in 1 collection/);
		assert.deepEqual(snapshot(ws), before);
		assert.deepEqual(landHolders(ws.root), []);
	});

	test('a refused landing exits 1 under --dry-run too', () => {
		const ws = landable();
		addAndCommit(ws.wt, 'first note');
		addNote(ws.root, 'someone elses pending note');
		const r = ws.land('worktrees/a', '--dry-run');
		assert.equal(r.code, 1, r.stdout);
		assert.match(r.stderr, /the primary has 1 pending record write/);
	});
});

describe('dt land --keep', () => {
	test('the worktree survives, reset onto the landed commit, and only the copy branch is deleted', () => {
		const ws = landable();
		addAndCommit(ws.wt, 'first note');

		const r = ws.land('worktrees/a', '--keep');
		assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
		assert.ok(fs.existsSync(ws.wt), '--keep removed the worktree');
		assert.equal(git(ws.wt, ['rev-parse', 'HEAD']), git(ws.root, ['rev-parse', 'HEAD']));
		assert.match(r.stdout, /worktree kept at /);
		assert.equal(git(ws.root, ['branch', '--list', 'land/a']), '', 'the copy branch survived');
		assert.notEqual(git(ws.root, ['branch', '--list', 'worktree-a']), '', '--keep deleted the branch');
	});
});

describe('dt land — the invocation itself', () => {
	test('a target that is not a worktree reference is refused with the spelling that works', () => {
		const ws = landable();
		const r = ws.land('nope');
		assert.equal(r.code, 1, r.stdout);
		assert.match(r.stderr, /dt land needs a worktree: dt land worktrees\/<name>/);
	});

	test('an unknown flag is refused rather than swallowed', () => {
		const ws = landable();
		const r = ws.land('worktrees/a', '--bogus');
		assert.equal(r.code, 1, r.stdout);
		assert.match(r.stderr, /unknown flag "--bogus"/);
	});

	test('--hook with no JSON on stdin says so instead of landing something', () => {
		const ws = landable();
		addAndCommit(ws.wt, 'first note');
		const before = snapshot(ws);
		const r = dtStdin(ws.root, '', 'land', '--hook', '--dry-run');
		assert.equal(r.code, 1, r.stdout);
		assert.match(r.stderr, /hook input is not JSON/);
		assert.deepEqual(snapshot(ws), before);
	});

	// ⚠ THE HOOK FORM NEVER REMOVES ANYTHING. WorktreeRemove fires as the harness is deleting the
	// worktree; the engine's job there is to SAY what is about to be lost, in a payload the session
	// reads, and a `land` that actually landed at that moment would race the harness's own removal.
	test('--hook --dry-run reports the pending landing for the worktree named on stdin and mutates nothing', () => {
		const ws = landable();
		addAndCommit(ws.wt, 'first note');
		const before = snapshot(ws);
		const r = dtStdin(ws.root, JSON.stringify({ cwd: ws.root, worktree_path: ws.wt, worktree_name: 'a' }), 'land', '--hook', '--dry-run');
		assert.equal(r.code, 0, r.stderr);
		assert.match(r.stdout, /1 commit · 1 record file in 1 collection/);
		assert.deepEqual(snapshot(ws), before);
	});

	test('--json answers with the landing as data', () => {
		const ws = landable();
		addAndCommit(ws.wt, 'first note');
		const r = ws.land('worktrees/a', '--json');
		assert.equal(r.code, 0, r.stderr);
		const out = JSON.parse(r.stdout);
		assert.equal(out.code, 0);
		assert.equal(out.landed.commits, 1);
		assert.deepEqual(out.landed.records, { notes: 1 });
	});
});
