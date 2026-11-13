// `dt update <name>[@<version>] | --engine` through the real binary, offline against the fixture registry.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { workspace, ENGINE_ROOT, git, treeHash } from '../helpers/ws.js';
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
