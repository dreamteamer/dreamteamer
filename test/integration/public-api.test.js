// The PUBLIC API is a contract with other repos, so it is pinned three ways: the runtime export list
// equals the typed declaration, importing it has no side effect, and an INSTALLED copy exposes it
// while hiding `src/*` — a source-tree import passing proves nothing about what npm ships.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { workspace, git, ENGINE_ROOT } from '../helpers/ws.js';

const DTS = fs.readFileSync(path.join(ENGINE_ROOT, 'src', 'api.d.ts'), 'utf8');

/** Every runtime name `api.d.ts` declares: `export function|const|class X`, and the comma lists. */
function declared() {
	const names = new Set();
	for (const m of DTS.matchAll(/^export (?:declare )?(?:function|class|const) ([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
	for (const m of DTS.matchAll(/^export const ([^;]+);/gm)) {
		for (const part of m[1].split(/,\s*/)) { const n = /^([A-Za-z_$][\w$]*)\s*:/.exec(part.trim()); if (n) names.add(n[1]); }
	}
	return names;
}

describe('dreamteamer (the public API)', () => {
	test('the runtime exports are exactly the declared ones', async () => {
		const api = await import('../../src/api.js');
		const runtime = new Set(Object.keys(api));
		const types = declared();
		assert.ok(types.size > 60, `the declaration parse found only ${types.size} names — the pattern no longer matches api.d.ts`);
		assert.deepEqual([...runtime].filter((n) => !types.has(n)).sort(), [], 'exported but not declared in api.d.ts');
		assert.deepEqual([...types].filter((n) => !runtime.has(n)).sort(), [], 'declared in api.d.ts but not exported');
	});

	test('importing it prints nothing, writes nothing, and binds nothing', () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-api-'));
		const url = new URL('../../src/api.js', import.meta.url).href;
		const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)}); console.log('HANDLES', process._getActiveHandles().length)`], { cwd, encoding: 'utf8', timeout: 30_000 });
		assert.equal(r.status, 0, r.stderr);
		assert.equal(r.stderr, '');
		assert.equal(r.stdout.trim(), 'HANDLES 0');
		assert.deepEqual(fs.readdirSync(cwd), [], 'importing the API wrote into the cwd');
	});

	test('openWorkspace returns the handle with its (empty) extensions, and changes no cwd', async () => {
		const { openWorkspace } = await import('../../src/api.js');
		const ws = workspace();
		const before = process.cwd();
		const handle = await openWorkspace(ws.root);
		assert.equal(handle.root, ws.root);
		assert.deepEqual(handle.extensions, []);
		assert.equal(process.cwd(), before);
	});
});

describe('the INSTALLED package', () => {
	test('`import "dreamteamer"` resolves to the API, and `dreamteamer/src/*` is not reachable', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-pack-'));
		// pack exactly what `files` publishes, then install that tarball — never the source tree
		const tgz = execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], { cwd: ENGINE_ROOT, encoding: 'utf8', timeout: 120_000 }).trim().split('\n').pop();
		fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
		const inst = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline', path.join(dir, tgz)], { cwd: dir, encoding: 'utf8', timeout: 300_000 });
		assert.equal(inst.status, 0, inst.stderr);
		// the core install is LEAN: no HTTP framework, no optional tool
		const installed = fs.readdirSync(path.join(dir, 'node_modules'));
		assert.ok(!installed.includes('express'), 'express is still in the core dependency tree');
		const pub = spawnSync(process.execPath, ['-e', "import('dreamteamer').then((m) => console.log(m.apiVersion, typeof m.openWorkspace, typeof m.Store))"], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
		assert.equal(pub.stdout.trim(), '1 function function', pub.stderr);
		const deep = spawnSync(process.execPath, ['-e', "import('dreamteamer/src/store.js').then(() => console.log('REACHED'), (e) => console.log(e.code))"], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
		assert.equal(deep.stdout.trim(), 'ERR_PACKAGE_PATH_NOT_EXPORTED');
		// and the extracted tools are NOT in the tarball
		const listing = execFileSync('tar', ['-tzf', path.join(dir, tgz)], { encoding: 'utf8' });
		for (const gone of ['src/server.js', 'src/prove.js', 'src/land.js', 'src/containers.js', 'src/container-archive.js', 'src/export-notebooklm.js']) {
			assert.ok(!listing.includes(`package/${gone}`), `${gone} is still published`);
		}
		assert.ok(listing.includes('package/src/api.d.ts'), 'the type declarations are not published');
	});
});

describe('dt init commits only what it wrote', () => {
	test('unrelated staged and unstaged work in an existing repo is left exactly as it was', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-init-'));
		git(dir, ['init', '-q']);
		git(dir, ['config', 'user.email', 'test@example.invalid']); git(dir, ['config', 'user.name', 'dreamteamer test']);
		fs.writeFileSync(path.join(dir, 'staged.txt'), 'mine, staged\n');
		fs.writeFileSync(path.join(dir, 'loose.txt'), 'mine, untracked\n');
		git(dir, ['add', 'staged.txt']);
		const bin = fileURLToPath(new URL('../../bin/dreamteamer.js', import.meta.url));
		const r = spawnSync(process.execPath, [bin, 'init'], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
		assert.equal(r.status, 0, r.stderr);
		const committed = git(dir, ['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean);
		assert.ok(committed.includes('package.json') && committed.includes('.gitignore'), committed.join(', '));
		assert.ok(!committed.includes('staged.txt'), 'init swept an unrelated STAGED file into its commit');
		assert.ok(!committed.includes('loose.txt'), 'init swept an unrelated untracked file into its commit');
		const status = git(dir, ['status', '--porcelain']);
		assert.match(status, /^A {2}staged\.txt$/m, 'the operator\'s staged file is no longer staged');
		assert.match(status, /^\?\? loose\.txt$/m);
	});
});
