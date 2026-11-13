// held-out cr-dt-006-he6 — init inside a git worktree (a linked checkout whose .git is a FILE), not a
// primary. rnd/tests/cr-dt-006-he6.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { withEngine, folder, dt, git, cleanup } from './held-out-cr-dt-006-lib.js';

after(cleanup);
/** Every file outside node_modules/ and .git, with its bytes and mtime. */
function snapshot(root, dir = '', out = {}) {
	for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
		const rel = path.join(dir, e.name), p = path.join(root, rel);
		if (e.isDirectory()) { if (!(dir === '' && ['node_modules', '.git'].includes(e.name))) snapshot(root, rel, out); }
		else if (e.isFile()) out[rel] = `${createHash('sha256').update(fs.readFileSync(p)).digest('hex')} ${fs.lstatSync(p).mtimeMs}`;
		else if (e.isSymbolicLink()) out[rel] = `-> ${fs.readlinkSync(p)}`;
	}
	return out;
}

test('he6: one scoped commit on the worktree branch, no git init, the primary untouched, a second run changes nothing', () => {
	const primary = folder('primary');
	git(primary, ['init', '-q', '-b', 'main']);
	fs.writeFileSync(path.join(primary, 'README.md'), 'primary\n');
	git(primary, ['add', 'README.md']); git(primary, ['commit', '-qm', 'first']);
	const primaryHead = git(primary, ['rev-parse', 'HEAD']);
	const wt = path.join(path.dirname(primary), path.basename(primary) + '-wt');
	git(primary, ['worktree', 'add', '-q', wt, '-b', 'wt']);
	assert.ok(fs.statSync(path.join(wt, '.git')).isFile(), '.git in a linked checkout is a file');
	const gitFile = fs.readFileSync(path.join(wt, '.git'));
	withEngine(wt);
	const r = dt(wt, ['init']);
	assert.equal(r.code, 0, r.stdout + r.stderr);
	assert.doesNotMatch(r.stdout, /repository created/, 'no git init was run');
	assert.ok(fs.readFileSync(path.join(wt, '.git')).equals(gitFile), 'the .git file is byte-identical');
	assert.equal(git(wt, ['rev-parse', '--abbrev-ref', 'HEAD']), 'wt');
	assert.equal(git(wt, ['rev-list', '--count', 'HEAD']), '2', 'exactly one commit on top of the primary\'s');
	assert.match(git(wt, ['log', '-1', '--format=%s']), /^dreamteamer: init workspace/);
	const committed = git(wt, ['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean).sort();
	assert.deepEqual(committed, ['.env.example', '.gitignore', '.vscode/extensions.json', 'modules/default/collections/notes.collection.yaml', 'modules/default/package.json', 'package.json'], 'exactly the init pathspec');
	assert.equal(git(wt, ['status', '--porcelain']), '', 'nothing left uncommitted in the worktree');
	assert.equal(git(primary, ['rev-parse', 'HEAD']), primaryHead, 'the primary\'s HEAD untouched');
	assert.equal(git(primary, ['status', '--porcelain']), '', 'the primary\'s index and tree untouched');
	assert.equal(git(primary, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
	const before = snapshot(wt);
	const again = dt(wt, ['init']);
	assert.equal(again.code, 0, again.stderr);
	assert.deepEqual(snapshot(wt), before, 'the second run changed zero files');
	assert.match(again.stdout, /every declared package installed/, 'it prints what it found');
	assert.match(again.stdout, /compile: fresh|nothing new to commit/, again.stdout);
	assert.equal(git(wt, ['rev-list', '--count', 'HEAD']), '2', 'no second commit');
});
