import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { describeCheckout, defaultGit, planInstall } from '../../src/checkout.js';

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
	});
});
