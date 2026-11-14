// `dt update <name>[@<version>] | --engine` through the real binary, offline against the fixture registry.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { workspace, ENGINE_ROOT, git, treeHash } from '../helpers/ws.js';
import { resolveNpm } from '../../src/checkout.js';
import { buildRegistry } from '../fixtures/registry/build.mjs';

const BIN = path.join(ENGINE_ROOT, 'bin', 'dreamteamer.js');
let REG;
before(() => { REG = buildRegistry(); });
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-home-'));
const run = (root, args) => {
	const r = spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8', timeout: 180_000, killSignal: 'SIGKILL', env: { PATH: process.env.PATH, HOME, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } });
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
const installed = (root, name) => { try { return JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version; } catch { return null; } };

describe('dt update — one pin forward, on purpose', () => {
	test('a module moves to the newest in the folder, re-pinned, compiled, committed; again is nothing to do', () => {
		const ws = offline();
		assert.equal(run(ws.root, ['install', '@fix/a@1.0.0', '--from', REG]).code, 0);
		assert.equal(installed(ws.root, '@fix/a'), '1.0.0');
		const r = run(ws.root, ['update', '@fix/a', '--from', REG]);
		assert.equal(r.code, 0, r.stderr + r.stdout);
		assert.equal(installed(ws.root, '@fix/a'), '1.1.0');
		assert.match(git(ws.root, ['log', '-1', '--pretty=%s']), /^dreamteamer: update @fix\/a 1\.0\.0 → 1\.1\.0$/);
		assert.equal(git(ws.root, ['status', '--porcelain']), '');
		const h = treeHash(ws.root);
		const again = run(ws.root, ['update', '@fix/a', '--from', REG]);
		assert.equal(again.code, 0);
		assert.match(again.stdout, /already 1\.1\.0 — nothing to do/);
		assert.equal(treeHash(ws.root), h);
	});

	test('the setup half runs the version npm just installed, not the one this process imported (rnd/tests/dreamteamer/update-runs-new-unit)', () => {
		const ws = offline();
		const i = run(ws.root, ['install', '@fix/unit@1.0.0', '--from', REG]);
		assert.equal(i.code, 0, i.stderr + i.stdout);   // an optional input: the unit's own needs, not exit 3
		assert.match(i.stdout, /needs input: calendar/);
		const r = run(ws.root, ['update', '@fix/unit', '--from', REG]);
		assert.equal(r.code, 0, r.stderr + r.stdout);
		assert.equal(installed(ws.root, '@fix/unit'), '1.1.0');
		assert.doesNotMatch(r.stdout, /needs input: calendar/);
		assert.match(r.stdout, /✔ unit: ready/);   // the 1.1.0 unit: nothing missing
		assert.match(git(ws.root, ['log', '-1', '--pretty=%s']), /^dreamteamer: update @fix\/unit 1\.0\.0 → 1\.1\.0$/);
		assert.equal(git(ws.root, ['status', '--porcelain']), '');
	});

	test('a new version whose setup half cannot load: exit 1, one ✖ line naming dt install, never Node\'s trace', () => {
		const ws = offline();
		assert.equal(run(ws.root, ['install', '@fix/unit@1.0.0', '--from', REG]).code, 0);
		// a folder of tarballs that also holds a 1.2.0 whose entry throws when it is imported
		const from = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-broken-'));
		for (const f of fs.readdirSync(REG)) fs.copyFileSync(path.join(REG, f), path.join(from, f));
		const src = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-broken-src-'));
		fs.cpSync(path.join(ENGINE_ROOT, 'test', 'fixtures', 'registry', 'src', 'fix-unit-1.1.0'), src, { recursive: true });
		const pj = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8')); pj.version = '1.2.0'; fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify(pj, null, '\t'));
		fs.writeFileSync(path.join(src, 'entry.js'), 'throw new Error("unit 1.2.0 is broken");\nexport default () => ({});\n');
		assert.equal(spawnSync('npm', ['pack', src, '--pack-destination', from, '--silent'], { encoding: 'utf8' }).status, 0);
		const r = run(ws.root, ['update', '@fix/unit', '--from', from]);
		assert.equal(r.code, 1, r.stderr + r.stdout);
		assert.match(r.stderr, /✖ .*dt install @fix\/unit/);
		assert.doesNotMatch(r.stderr, /^\s+at /m, 'no stack frames');
		assert.doesNotMatch(r.stderr, /Node\.js v\d/, 'no Node version banner');
	});

	test('a downgrade is refused unless --allow downgrade; a named version within the folder is honoured', () => {
		const ws = offline();
		assert.equal(run(ws.root, ['install', '@fix/a', '--from', REG]).code, 0);
		assert.equal(installed(ws.root, '@fix/a'), '1.1.0');
		const d = run(ws.root, ['update', '@fix/a@1.0.0', '--from', REG]);
		assert.equal(d.code, 1);
		assert.match(d.stderr, /is a downgrade — say so: dt update @fix\/a@1\.0\.0 --allow downgrade/);
		assert.equal(installed(ws.root, '@fix/a'), '1.1.0');
		const ok = run(ws.root, ['update', '@fix/a@1.0.0', '--from', REG, '--allow', 'downgrade']);
		assert.equal(ok.code, 0, ok.stderr);
		assert.equal(installed(ws.root, '@fix/a'), '1.0.0');
	});

	test('a development link is skipped and named; a package that is not installed is refused', () => {
		const ws = offline();
		assert.equal(run(ws.root, ['install', path.join(ENGINE_ROOT, 'test', 'fixtures', 'registry', 'src', 'fix-b-1.0.0')]).code, 0);
		const r = run(ws.root, ['update', '@fix/b', '--from', REG]);
		assert.equal(r.code, 0, r.stderr);
		assert.match(r.stdout, /@fix\/b: a development link — skipped/);
		const n = run(ws.root, ['update', '@fix/a', '--from', REG]);
		assert.equal(n.code, 1);
		assert.match(n.stderr, /@fix\/a is not installed — dt install @fix\/a/);
	});

	test('a version that adds a dreamteamer.dependencies entry brings the dependency in: closure installed, compiled, committed in one go', () => {
		const ws = offline();
		assert.equal(run(ws.root, ['install', '@fix/d@1.0.0', '--from', REG]).code, 0);
		assert.equal(installed(ws.root, '@fix/c'), null, 'not there yet');
		const r = run(ws.root, ['update', '@fix/d', '--from', REG]);
		assert.equal(r.code, 0, r.stderr + r.stdout);
		assert.equal(installed(ws.root, '@fix/d'), '2.0.0');
		assert.equal(installed(ws.root, '@fix/c'), '1.0.0', 'the new dependency came with it');
		assert.ok(fs.existsSync(path.join(ws.root, '.dreamteamer', 'collections', 'fixcs.collection.yaml')), 'compiled with it');
		assert.match(git(ws.root, ['log', '-1', '--pretty=%s']), /^dreamteamer: update @fix\/d 1\.0\.0 → 2\.0\.0$/);
		assert.equal(git(ws.root, ['status', '--porcelain']), '', 'nothing half-written');
		const h = treeHash(ws.root);
		assert.equal(run(ws.root, ['update', '@fix/d', '--from', REG]).code, 0);
		assert.equal(treeHash(ws.root), h);
	});

	test('--engine: already at this version is nothing to do; a linked engine is skipped', () => {
		const ws = offline();
		// the fixture's engine is a file: link to this checkout — a development link, by its own rule
		const r = run(ws.root, ['update', '--engine', '--from', REG]);
		assert.equal(r.code, 0, r.stderr);
		assert.match(r.stdout, /dreamteamer: a development link — skipped/);
	});

	test('no target keeps its meaning: git modules, and a pointer for npm ones', () => {
		const ws = offline();
		const r = run(ws.root, ['update']);
		assert.equal(r.code, 0, r.stderr);
		assert.match(r.stdout, /no git_modules declared/);
	});
});

// rnd/tests/dreamteamer/update-preset — CR-dt-008: `dt update` of a module preset moves the installed
// members to the new pins, installs a member new to the version, never re-installs one the operator
// removed, and refuses a member downgrade unless it is asked for.
describe('dt update <module preset>', () => {
	const pinOf = (root, name) => {
		const spec = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies?.[name];
		if (spec == null) return null;
		const m = /^file:.*-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.tgz$/.exec(spec);
		return m ? m[1] : spec;
	};
	const npmUninstall = (root, name) => {
		const r = spawnSync(resolveNpm(), ['uninstall', name, '--no-audit', '--no-fund'], { cwd: root, encoding: 'utf8', timeout: 120_000, env: { PATH: process.env.PATH, HOME } });
		assert.equal(r.status, 0, r.stderr);
	};

	test('first expansion: a plain 0.9.0 becoming a preset installs every member at its pin', () => {
		const ws = offline();
		assert.equal(run(ws.root, ['install', '@fix/set@0.9.0', '--from', REG]).code, 0);
		const r = run(ws.root, ['update', '@fix/set@1.0.0', '--from', REG]);
		assert.equal(r.code, 0, r.stderr + r.stdout);
		for (const name of ['@fix/a', '@fix/b', '@fix/c', '@fix/set']) {
			assert.equal(pinOf(ws.root, name), '1.0.0', `${name} pinned`);
			assert.equal(installed(ws.root, name), '1.0.0', `${name} installed`);
		}
	});

	test('a removed member stays removed, a new one comes in, an installed one moves; a member downgrade needs --allow downgrade', () => {
		const ws = offline();
		assert.equal(run(ws.root, ['install', '@fix/set@1.0.0', '--from', REG]).code, 0);
		npmUninstall(ws.root, '@fix/c');
		const c = run(ws.root, ['compile']);
		assert.equal(c.code, 0, c.stderr + c.stdout);
		const r = run(ws.root, ['update', '@fix/set', '--from', REG]);
		assert.equal(r.code, 0, r.stderr + r.stdout);
		assert.equal(installed(ws.root, '@fix/a'), '1.1.0');
		assert.equal(installed(ws.root, '@fix/d'), '1.0.0', 'new to 1.1.0, so installed');
		assert.equal(pinOf(ws.root, '@fix/c'), null, 'removed on purpose, never re-installed');
		assert.equal(installed(ws.root, '@fix/c'), null);
		assert.match(r.stdout, /members: @fix\/a 1\.0\.0 → 1\.1\.0/);
		assert.match(r.stdout, /with @fix\/d/);

		const before = fs.readFileSync(path.join(ws.root, 'package.json'), 'utf8');
		const down = run(ws.root, ['update', '@fix/set@1.0.0', '--from', REG]);
		assert.equal(down.code, 1, down.stdout);
		assert.match(down.stderr, /downgrade/);
		assert.equal(fs.readFileSync(path.join(ws.root, 'package.json'), 'utf8'), before, 'package.json byte-identical');
		const allowed = run(ws.root, ['update', '@fix/set@1.0.0', '--from', REG, '--allow', 'downgrade']);
		assert.equal(allowed.code, 0, allowed.stderr + allowed.stdout);
		assert.equal(installed(ws.root, '@fix/a'), '1.0.0', 'back at the pin');
	});

	test('a member the operator moved past the new pin is a member downgrade: refused naming the preset, before npm', () => {
		const ws = offline();
		assert.equal(run(ws.root, ['install', '@fix/a@1.1.0', '--from', REG]).code, 0);
		assert.equal(run(ws.root, ['install', '@fix/set@0.9.0', '--from', REG]).code, 0);
		const h = treeHash(ws.root);
		const r = run(ws.root, ['update', '@fix/set@1.0.0', '--from', REG]);
		assert.equal(r.code, 1, r.stdout);
		assert.match(r.stderr, /@fix\/a 1\.1\.0 → 1\.0\.0 is a downgrade \(module preset set names 1\.0\.0\) — say so: dt update @fix\/set@1\.0\.0 --allow downgrade/);
		assert.equal(treeHash(ws.root), h);
	});
});
