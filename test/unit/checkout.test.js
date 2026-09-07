import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { describeCheckout } from '../../src/checkout.js';

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
	});
	test('a linked worktree outside the primary root (a home-directory location)', () => {
		const c = describeCheckout('/home/u/.codex/worktrees/x/ws', fakeGit({
			'rev-parse --git-dir': '/w/ws/.git/worktrees/x', 'rev-parse --git-common-dir': '/w/ws/.git' }));
		assert.equal(c.kind, 'linked');
		assert.equal(c.primary, '/w/ws');
		assert.equal(c.insideRoot, false);
	});
	test('not a git checkout at all throws a named error', () => {
		assert.throws(() => describeCheckout('/w/ws', () => { throw new Error('fatal: not a git repository'); }), /not a git checkout/);
	});
});
