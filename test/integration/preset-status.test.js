// rnd/tests/dreamteamer/preset-status — CR-dt-008: `dt status` (text and --json) reports a module
// preset's members: how many are here, which are absent, and which drifted from the preset's pin.
// Offline against the fixture registry, as install-modules.test.js runs.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { workspace, ENGINE_ROOT, git } from '../helpers/ws.js';
import { buildRegistry } from '../fixtures/registry/build.mjs';
import { resolveNpm } from '../../src/checkout.js';

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

describe('dt status reports a module preset\'s members', () => {
	test('text: the count, an absent member, a drifted member; --json: preset and members on the preset only', () => {
		const ws = offline();
		const i = run(ws.root, ['install', '@fix/set@1.0.0', '--from', REG]);
		assert.equal(i.code, 0, i.stderr + i.stdout);
		const u = run(ws.root, ['update', '@fix/a', '--from', REG]);
		assert.equal(u.code, 0, u.stderr + u.stdout);
		const npm = spawnSync(resolveNpm(), ['uninstall', '@fix/c', '--no-audit', '--no-fund'], { cwd: ws.root, encoding: 'utf8', env: ENV, timeout: 120_000 });
		assert.equal(npm.status, 0, npm.stderr);
		const c = run(ws.root, ['compile']);
		assert.equal(c.code, 0, c.stderr + c.stdout);

		const s = run(ws.root, ['status']);
		assert.equal(s.code, 0, s.stderr + s.stdout);
		assert.match(s.stdout, /@fix\/set\s+node_modules · preset · 2 members · 1 installed/);
		assert.ok(s.stdout.includes('@fix/c  not installed — dt install @fix/c'), s.stdout);
		assert.ok(s.stdout.includes('@fix/a 1.1.0 (preset set names 1.0.0)'), s.stdout);

		const j = JSON.parse(run(ws.root, ['status', '--json']).stdout);
		const set = j.modules.find((m) => m.name === '@fix/set');
		assert.equal(set.preset, true);
		assert.deepEqual(set.members, [{ name: '@fix/a', pinned: '1.0.0', installed: '1.1.0' }, { name: '@fix/c', pinned: '1.0.0', installed: null }]);
		const b = j.modules.find((m) => m.name === '@fix/b');
		assert.ok(b, JSON.stringify(j.modules));
		assert.equal('preset' in b, false);
	});
});
