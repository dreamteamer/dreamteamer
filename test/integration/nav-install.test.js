// rnd/tests/dreamteamer/install-nav-fragment — cr-dt-008: install and update merge the shipped nav fragments
// into nav.yaml after compile, inside the pre-image restore, and commit nav.yaml only when they placed
// something. Offline against the fixture registry, as install-modules.test.js runs.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { workspace, ENGINE_ROOT, git, readFile } from '../helpers/ws.js';
import { buildRegistry } from '../fixtures/registry/build.mjs';
import { resolveNpm } from '../../src/checkout.js';
import { readNavDoc } from '../../src/nav.js';
import { NAV_SETTINGS_LINE } from '../../src/nav-fragments.js';

const BIN = path.join(ENGINE_ROOT, 'bin', 'dreamteamer.js');
let REG;
before(() => { REG = buildRegistry(); });
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-home-'));
const ENV = { PATH: process.env.PATH, HOME, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
const run = (root, args) => {
	const r = spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8', timeout: 180_000, killSignal: 'SIGKILL', env: ENV });
	return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};
function offline() {
	const ws = workspace();
	const pkgFile = path.join(ws.root, 'package.json');
	const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
	pkg.dependencies = { ...pkg.dependencies, dreamteamer: `file:${ENGINE_ROOT}` };
	fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, '\t') + '\n');
	git(ws.root, ['add', '-A']);
	if (git(ws.root, ['status', '--porcelain'])) git(ws.root, ['commit', '-qm', 'fixture: offline engine']);
	return ws;
}
const ok = (r) => assert.equal(r.code, 0, r.stderr + r.stdout);
const lastFiles = (root) => git(root, ['show', '--name-only', '--pretty=', 'HEAD']).split('\n').filter(Boolean);
const uninstall = (root, name) => { const r = spawnSync(resolveNpm(), ['uninstall', name, '--no-audit', '--no-fund'], { cwd: root, encoding: 'utf8', env: ENV, timeout: 120_000 }); assert.equal(r.status, 0, r.stderr); };

describe('install and update merge the nav fragments', () => {
	test('a preset\'s fragment lands with its install; a module with none leaves nav.yaml alone; update adds the new member', () => {
		const ws = offline();
		ok(run(ws.root, ['install', '@fix/set@1.0.0', '--from', REG]));
		assert.deepEqual(readNavDoc(ws.root).tree, [{ folder: 'Fixtures', items: ['fixas', 'fixcs'] }]);
		assert.ok(lastFiles(ws.root).includes('nav.yaml'), lastFiles(ws.root).join(','));
		const before = readFile(ws.root, 'nav.yaml');
		ok(run(ws.root, ['install', '@fix/d@1.0.0', '--from', REG]));
		assert.equal(readFile(ws.root, 'nav.yaml'), before, 'byte-identical');
		assert.ok(!lastFiles(ws.root).includes('nav.yaml'), lastFiles(ws.root).join(','));
		// @fix/d is installed now, so the update moves @fix/a and @fix/set; the fragment still places fixds
		const u = run(ws.root, ['update', '@fix/set', '--from', REG]);
		ok(u);
		assert.deepEqual(readNavDoc(ws.root).tree, [{ folder: 'Fixtures', items: ['fixas', 'fixcs', 'fixds'] }]);
		assert.ok(lastFiles(ws.root).includes('nav.yaml'), `the update commit (written by the child): ${lastFiles(ws.root).join(',')}`);
		assert.equal(git(ws.root, ['status', '--porcelain', '--', 'nav.yaml']), '');
	});
	test('a removed member is dropped from the merge without an error', () => {
		const ws = offline();
		ok(run(ws.root, ['install', '@fix/set@1.0.0', '--from', REG]));
		uninstall(ws.root, '@fix/c');
		git(ws.root, ['rm', '-q', 'nav.yaml']);
		git(ws.root, ['commit', '-qm', 'no nav']);
		ok(run(ws.root, ['compile']));
		const u = run(ws.root, ['update', '@fix/set', '--from', REG]);
		ok(u);
		assert.deepEqual(readNavDoc(ws.root).tree, [{ folder: 'Fixtures', items: ['fixas', 'fixds'] }]);
	});
	test('a fragment placing another module\'s collection refuses and restores the pre-image', () => {
		const ws = offline();
		ok(run(ws.root, ['install', '@fix/a@1.1.0', '--from', REG]));
		const pkg = readFile(ws.root, 'package.json'), lock = readFile(ws.root, 'package-lock.json');
		const r = run(ws.root, ['install', '@fix/bad-nav', '--from', REG]);
		assert.equal(r.code, 1, r.stderr + r.stdout);
		assert.match(r.stderr, /nav\.yaml of @fix\/bad-nav places fixas, which @fix\/a owns/);
		assert.match(r.stderr, /are as before the call/);
		assert.equal(readFile(ws.root, 'package.json'), pkg);
		assert.equal(readFile(ws.root, 'package-lock.json'), lock);
		assert.equal(readFile(ws.root, 'nav.yaml'), null);
	});
	test('a namespace entry from the module that declares the namespace', () => {
		const ws = offline();
		ok(run(ws.root, ['install', '@fix/ns', '--from', REG]));
		assert.deepEqual(readNavDoc(ws.root).tree, [{ namespace: 'fixns', items: ['fixns/items'] }]);
	});
	test('old nav settings with no nav.yaml: a module with no fragment installs, says so, and writes no nav.yaml', () => {
		const ws = offline();
		fs.mkdirSync(path.join(ws.root, '.vscode'), { recursive: true });
		fs.writeFileSync(path.join(ws.root, '.vscode', 'settings.json'), '{"dreamteamer.navOrder": ["fixds"]}');
		const r = run(ws.root, ['install', '@fix/d@1.0.0', '--from', REG]);
		ok(r);
		assert.ok(r.stdout.includes(NAV_SETTINGS_LINE), r.stdout);
		assert.equal(readFile(ws.root, 'nav.yaml'), null);
	});
});
