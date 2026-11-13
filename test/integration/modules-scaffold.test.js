// `dt add modules --extension --package` (cr-dt-007, G4, D65): the scaffold a stranger starts from
// already passes the gate — its extension entry is in the tarball, its floor is the running engine,
// its files list covers every kind, it has a README with the install line, and one commit carries it all.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { twoModuleWorkspace, readFile, ENGINE_ROOT, git } from '../helpers/ws.js';
import { KINDS } from '../../src/compile.js';
import { resolveNpm, childEnv } from '../../src/checkout.js';

const VERSION = JSON.parse(fs.readFileSync(path.join(ENGINE_ROOT, 'package.json'), 'utf8')).version;
const pkgOf = (ws, id) => JSON.parse(readFile(ws.root, `modules/${id}/package.json`));

describe('dt add modules — a publishable scaffold', () => {
	test('--extension --package: the files, the manifest, the commit, the tarball, status, and the gate', () => {
		const ws = twoModuleWorkspace();
		const r = ws.dt('add', 'modules', '--name', 'acme', '--extension', '--package', '@acme/acme', '--description', 'Acme records.');
		assert.equal(r.code, 0, r.stdout + r.stderr);
		for (const f of ['package.json', 'README.md', 'src/extension.js', 'test/module.test.mjs']) assert.ok(fs.existsSync(path.join(ws.root, 'modules/acme', f)), f);
		assert.match(r.stdout, /package\.json · README\.md · test\/module\.test\.mjs · src\/extension\.js/);
		assert.equal(git(ws.root, ['status', '--porcelain']), '', 'nothing the scaffold changed is left outside its commit (.env.example included)');
		const stat = git(ws.root, ['show', '--name-only', '--pretty=', 'HEAD']).split('\n').filter(Boolean).filter((f) => f !== '.env.example').sort();
		assert.deepEqual(stat, ['modules/acme/README.md', 'modules/acme/package.json', 'modules/acme/src/extension.js', 'modules/acme/test/module.test.mjs']);
		const pkg = pkgOf(ws, 'acme');
		assert.equal(pkg.name, '@acme/acme');
		assert.equal(pkg.version, '0.1.0');
		assert.equal(pkg.type, 'module');
		assert.ok(!pkg.private, 'publishable');
		assert.deepEqual(new Set(pkg.files), new Set([...KINDS, 'README.md', 'src']));
		assert.equal(pkg.dreamteamer.engine, `>=${VERSION}`);
		assert.equal(pkg.dreamteamer.extension, './src/extension.js');
		assert.deepEqual(pkg.dreamteamer.env, ['ACME_TOKEN']);
		assert.equal(pkg.dreamteamer.description, 'Acme records.');
		assert.equal(pkg.devDependencies.dreamteamer, VERSION);
		assert.equal(pkg.scripts.test, 'node --test', 'the README says npm test — there is a test script to run');
		assert.equal(pkg.dependencies, undefined, 'never a dependencies entry on the engine');
		assert.match(readFile(ws.root, 'modules/acme/README.md'), /dt install @acme\/acme/);
		// the tarball carries the entry and the README
		const npm = resolveNpm();
		const dry = spawnSync(npm, ['pack', '--dry-run', '--json'], { cwd: path.join(ws.root, 'modules/acme'), encoding: 'utf8', env: childEnv() });
		const listed = JSON.parse(dry.stdout)[0].files.map((f) => f.path);
		assert.ok(listed.includes('src/extension.js') && listed.includes('README.md'), listed.join(', '));
		// live, and its unit reads missing with the fix line whole
		assert.equal(ws.dt('compile').code, 0);
		const s = ws.dt('status');
		assert.match(s.stdout, /acme\s+configured\s+ACME_TOKEN missing\s+→ dt setup acme --input token=<token>/);
		// and the gate passes before the author writes a line, and so does the scaffolded test
		const gate = ws.dt('check', 'modules/acme', '--alone');
		assert.equal(gate.code, 0, gate.stdout + gate.stderr);
		const t = spawnSync(resolveNpm(), ['test'], { cwd: path.join(ws.root, 'modules/acme'), encoding: 'utf8', env: childEnv(), timeout: 300_000 });
		assert.equal(t.status, 0, t.stdout + t.stderr);
	});

	test('no flags: today\'s scaffold plus type, the floor, the files list and a README', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('add', 'modules', '--name', 'payroll').code, 0);
		const pkg = pkgOf(ws, 'payroll');
		assert.equal(pkg.name, 'payroll');
		assert.equal(pkg.private, true);
		assert.equal(pkg.type, 'module');
		assert.equal(pkg.dreamteamer.engine, `>=${VERSION}`);
		assert.deepEqual(pkg.files, [...KINDS, 'README.md']);
		assert.ok(!fs.existsSync(path.join(ws.root, 'modules/payroll/src')));
	});

	test('--extension alone keeps the module private; --package with a bad npm name is refused with no folder left', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('add', 'modules', '--name', 'tools', '--extension').code, 0);
		assert.equal(pkgOf(ws, 'tools').private, true);
		assert.ok(pkgOf(ws, 'tools').files.includes('src'));
		const bad = ws.dt('add', 'modules', '--name', 'other', '--package', 'Not A Name');
		assert.notEqual(bad.code, 0);
		assert.match(bad.stderr, /"Not A Name" is not an npm package name/);
		assert.ok(!fs.existsSync(path.join(ws.root, 'modules/other')));
	});

	test('--extension on an id that starts with a digit is refused before anything is written: it becomes a unit id and an env key', () => {
		const ws = twoModuleWorkspace();
		const r = ws.dt('add', 'modules', '--name', '3d', '--extension');
		assert.notEqual(r.code, 0);
		assert.match(r.stderr, /--extension needs a module id that starts with a letter/);
		assert.ok(!fs.existsSync(path.join(ws.root, 'modules/3d')));
	});

	test('--package naming a package another module of this workspace already is: refused, naming it', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('add', 'modules', '--name', 'first', '--package', '@acme/thing').code, 0);
		const r = ws.dt('add', 'modules', '--name', 'second', '--package', '@acme/thing');
		assert.notEqual(r.code, 0);
		assert.match(r.stderr, /@acme\/thing is already the package name of modules\/first/);
		assert.ok(!fs.existsSync(path.join(ws.root, 'modules/second')));
	});
});
