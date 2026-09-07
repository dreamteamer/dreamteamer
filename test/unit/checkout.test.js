import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { describeCheckout, defaultGit } from '../../src/checkout.js';

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
