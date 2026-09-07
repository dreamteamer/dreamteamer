// Tier 2 — describeCheckout against REAL git. The unit tests inject a fake git, which pins the
// derivation but cannot pin what git actually answers: an absolute --git-dir with a RELATIVE
// --git-common-dir from a subdirectory, and a realpath-based common dir when the checkout is
// reached through a symlink. Both were wrong in the first implementation and both are invisible to
// a fake, so they are asserted here, on disk.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeCheckout } from '../../src/checkout.js';
import { git } from '../helpers/ws.js';

let base, ws, linked;

before(() => {
	// OUTSIDE the engine's own tree, or the "no checkout at all" case would discover the engine
	// repo by walking up. Realpathed, so an assertion about `primary` compares one spelling of it.
	base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dt-checkout-')));
	ws = path.join(base, 'ws');
	linked = path.join(ws, '.worktrees', 'a');
	fs.mkdirSync(ws, { recursive: true });
	git(ws, ['init', '-q']);
	fs.writeFileSync(path.join(ws, 'README.md'), '# fixture\n');
	git(ws, ['add', 'README.md']);
	git(ws, ['commit', '-qm', 'first']);
	git(ws, ['worktree', 'add', '-q', '-b', 'side', linked]);
	fs.mkdirSync(path.join(ws, 'sub'));
});

after(() => fs.rmSync(base, { recursive: true, force: true }));

describe('describeCheckout against real git', () => {
	test('the primary checkout', () => {
		const c = describeCheckout(ws);
		assert.equal(c.kind, 'primary');
		assert.equal(c.primary, ws);
		assert.equal(c.insideRoot, true);
	});
	test('a SUBDIRECTORY of it reports the primary, not the subdirectory', () => {
		const c = describeCheckout(path.join(ws, 'sub'));
		assert.equal(c.kind, 'primary');
		assert.equal(c.primary, ws);
		assert.equal(c.insideRoot, true);
	});
	test('a linked worktree', () => {
		const c = describeCheckout(linked);
		assert.equal(c.kind, 'linked');
		assert.equal(c.primary, ws);
		assert.equal(c.insideRoot, true);
		assert.equal(c.commonDir, path.join(ws, '.git'));
	});
	test('a linked worktree reached through a SYMLINK is still inside its primary', () => {
		// git answers a realpath; the caller's path need not be one. /tmp → /private/tmp on macOS
		// makes this the everyday case rather than the exotic one.
		const alias = path.join(base, 'alias');
		fs.symlinkSync(linked, alias);
		const c = describeCheckout(alias);
		assert.equal(c.kind, 'linked');
		assert.equal(c.primary, ws);
		assert.equal(c.insideRoot, true);
	});
	test('a directory that is no checkout at all throws a named error', () => {
		const outside = fs.mkdtempSync(path.join(base, 'bare-'));
		assert.throws(() => describeCheckout(outside), /is not a git checkout/);
	});
});
