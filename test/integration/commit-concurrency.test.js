// Tier 2 — `dt commit` under CONCURRENT PROCESSES, which is how this is actually operated.
//
// ⚠ THE DEFECT THIS GUARDS IS SILENT DATA ABANDONMENT, not a crash. `commitPending` took no write
// lock at all: it sampled `git status`, planned a sweep from what it saw, then ran `git add` and
// `git commit`. Two sessions doing that at once collide on `.git/index.lock` and `HEAD` — which are
// repository-wide and do not care that the records are unrelated — and THE LOSER IS NOT TOLD. Its
// record stays on disk, uncommitted, with the write reported as successful, until the next unscoped
// commit sweeps it under somebody else's subject.
//
// It matters more since auto-commit was turned off: a write no longer commits, so the window
// between writing a record and publishing it is a whole session rather than milliseconds.
//
// These spawn REAL PROCESSES on purpose. The race is between processes on one repository, so an
// in-process test cannot see it — Node's sync exec already serializes a single process against
// itself, which is exactly why this went unnoticed by every other tier.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { workspace, simpleCollection } from '../helpers/ws.js';
import { Store } from '../../src/store.js';

const CLI = path.resolve(import.meta.dirname, '../../bin/dreamteamer.js');

/** Run N `dt commit` processes at once, each naming ONE distinct record. Resolves when all exit. */
const commitAllAtOnce = (root, refs) => Promise.all(refs.map((ref, i) => new Promise((resolve) => {
	execFile(process.execPath, [CLI, 'commit', ref, '-m', `publish ${i}`], { cwd: root },
		(err, stdout, stderr) => resolve({ ref, code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr) }));
})));

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

describe('concurrent dt commit', () => {
	test('every writer lands, and none is silently abandoned', async () => {
		const N = 6;
		const ws = workspace({ collections: { notes: simpleCollection({ storage: { suffix: 'note' } }) } });
		const refs = [];
		for (let i = 0; i < N; i++) {
			const { id } = ws.store.add('notes', { name: `Concurrent ${i}` });
			refs.push(`notes/${id}`);
		}
		// Nothing is published yet — auto-commit is off, which is the state that makes this bite.
		// Only the RECORDS are counted: a fresh workspace also carries its own uncommitted
		// scaffolding (the generated harness files, the descriptor compile touched), and sweeping
		// that into the assertion would make it fail for reasons that have nothing to do with the race.
		// ⚠ `-uall` is not optional here: git collapses an ENTIRELY untracked directory into a single
		// `?? data/` line, so a plain `--porcelain` reports six new records as one path and a filter
		// looking for them finds nothing. `commit.js` samples with `-uall` for the same reason.
		const pendingRecords = () => git(ws.root, 'status', '--porcelain', '-uall')
			.split('\n').filter((l) => l.includes('data/notes/'));
		assert.equal(pendingRecords().length, N);

		const before = Number(git(ws.root, 'rev-list', '--count', 'HEAD'));
		const results = await commitAllAtOnce(ws.root, refs);
		const after = Number(git(ws.root, 'rev-list', '--count', 'HEAD'));

		// ⚠ The assertion that matters is the TREE, not the exit codes: a writer that reported
		// success and left its record uncommitted is the exact shape of the defect.
		const stillPending = pendingRecords();
		assert.deepEqual(stillPending, [],
			`records left uncommitted after every writer returned: ${stillPending.join(', ')}`);
		assert.equal(after - before, N, `${after - before} of ${N} commits landed`);

		for (const r of results) {
			assert.equal(r.code, 0, `${r.ref} exited ${r.code}: ${r.stderr.split('\n')[0]}`);
			assert.ok(!/index\.lock|cannot lock ref/i.test(r.stderr), `${r.ref} hit a git lock: ${r.stderr.split('\n')[0]}`);
		}
		// And each record is genuinely IN history, not merely absent from `git status`.
		for (const ref of refs) {
			const id = ref.slice('notes/'.length);
			assert.doesNotThrow(() => git(ws.root, 'cat-file', '-e', `HEAD:data/notes/${id}.note.md`),
				`${ref} is not in HEAD`);
		}
	});

	test('a losing writer is never told it succeeded while leaving its record behind', async () => {
		// The narrower property, stated on its own because it is the one a reader cares about: exit
		// code 0 must MEAN the record is published. A refusal would be acceptable; a false success
		// is not.
		const ws = workspace({ collections: { notes: simpleCollection({ storage: { suffix: 'note' } }) } });
		const refs = [];
		for (let i = 0; i < 4; i++) {
			const { id } = ws.store.add('notes', { name: `Truthful ${i}` });
			refs.push(`notes/${id}`);
		}
		const results = await commitAllAtOnce(ws.root, refs);
		for (const r of results) {
			if (r.code !== 0) continue;                       // an honest refusal is allowed
			const id = r.ref.slice('notes/'.length);
			assert.doesNotThrow(() => git(ws.root, 'cat-file', '-e', `HEAD:data/notes/${id}.note.md`),
				`${r.ref} exited 0 but is not in HEAD — a false success`);
		}
	});
});

describe('the write lock belongs to the repository', () => {
	test('it lives in the git common dir, so every worktree of a repo shares one', () => {
		// ⚠ `.dreamteamer/` is gitignored build output and each checkout has its own. A lock there
		// serialized a checkout against itself and left two worktrees of one repo free to collide on
		// `.git/index.lock` — the very file the lock exists to protect.
		const ws = workspace({ collections: { notes: simpleCollection({ storage: { suffix: 'note' } }) } });
		const store = new Store(ws.ws);
		const lock = store.writeLockPath();
		const commonDir = path.resolve(ws.root, git(ws.root, 'rev-parse', '--git-common-dir'));
		assert.equal(path.dirname(lock), commonDir, 'the lock is not in the shared git dir');
		// Compare DIRECTORIES, not substrings — the lock is named `.dreamteamer-write-lock`, so a
		// naive `includes('.dreamteamer')` matches its own filename and asserts nothing.
		assert.notEqual(path.dirname(lock), store.runtime,
			'the lock must not live in per-checkout build output');
	});

	test('a workspace nested inside another repo locks THAT repo, which is the index git would use', () => {
		// Found by writing this test: removing the fixture's own `.git` does not make it
		// repository-less, because the fixture lives inside a checkout of this repo — and
		// `rev-parse` walks up. That is the RIGHT answer rather than a leak: every git command run
		// from that directory operates on the enclosing repo, so the enclosing repo's index is
		// exactly what has to be serialized. Pinned here so the walking-up behaviour is deliberate
		// and not rediscovered as a surprise.
		const ws = workspace({ collections: { notes: simpleCollection({ storage: { suffix: 'note' } }) } });
		fs.rmSync(path.join(ws.root, '.git'), { recursive: true, force: true });
		const store = new Store(ws.ws);
		const lock = store.writeLockPath();
		const enclosing = path.resolve(ws.root, git(ws.root, 'rev-parse', '--git-common-dir'));
		assert.equal(path.dirname(lock), enclosing, `locked ${lock} rather than the enclosing repo`);
		let ran = false;
		store.withWriteLock(() => { ran = true; });
		assert.ok(ran, 'the lock still works');
	});

	test('a workspace in no repository at all still locks, in the runtime folder', () => {
		// A store that cannot lock is worse than one that locks narrowly, and a workspace need not
		// be a repo. Built OUTSIDE any checkout, because the fixture root is not.
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-norepo-'));
		try {
			fs.mkdirSync(path.join(root, '.dreamteamer'), { recursive: true });
			const store = Object.create(Store.prototype);
			store.root = root;
			store.runtime = path.join(root, '.dreamteamer');
			assert.equal(path.dirname(store.writeLockPath()), store.runtime);
			let ran = false;
			store.withWriteLock(() => { ran = true; });
			assert.ok(ran, 'the lock still works with no repository anywhere above');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
