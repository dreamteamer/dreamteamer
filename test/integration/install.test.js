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
import { workspace, git, dt } from '../helpers/ws.js';

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
	test('a declared local asset present in the primary is linked', () => {
		const ws = workspace({ pkg: { 'local-assets': ['.profiles'] } });
		fs.mkdirSync(path.join(ws.root, '.profiles')); fs.appendFileSync(path.join(ws.root, '.gitignore'), '.profiles\n'); // no slash — see Task 4
		const wt = linkedWorktree(ws); // commits .gitignore and package.json before the worktree is cut
		assert.equal(dt(wt, 'install').code, 0);
		assert.ok(fs.lstatSync(path.join(wt, '.profiles')).isSymbolicLink());
	});
	// ⚠ TWO MODULES DECLARING THE SAME REL would otherwise produce two steps sharing one id, and
	// the second is silently dropped by any id-keyed lookup of the board.
	test('the same local asset declared twice yields ONE step', () => {
		const ws = workspace({ pkg: { 'local-assets': ['.profiles', '.profiles'] } });
		fs.mkdirSync(path.join(ws.root, '.profiles')); fs.appendFileSync(path.join(ws.root, '.gitignore'), '.profiles\n');
		const wt = linkedWorktree(ws);
		const r = dt(wt, 'install');
		assert.equal(r.code, 0, r.stderr);
		assert.equal(r.stdout.match(/\.profiles:/g).length, 1, `\`.profiles\` planned twice:\n${r.stdout}`);
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
