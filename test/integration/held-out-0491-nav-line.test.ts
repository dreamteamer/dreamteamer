// Held-out (0.49.1, rnd/tests/dreamteamer/held-out-0491-nav-line): the nav-migration line the REAL binary
// prints names a protocol version npm holds (0.3) and an editor version that was released (0.27) — for
// `dt install` of a module preset and `dt update` of a plain module, both with old nav settings and no
// nav.yaml — and the release's version is 0.49.1 in package.json and in both root entries of the lockfile.
// Offline against the fixture registry (test/fixtures/registry/build.mjs). Synthetic data only.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { workspace, ENGINE_ROOT, git, readFile, treeHash } from '../helpers/ws.ts';
import { buildRegistry } from '../fixtures/registry/build.mjs';

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
const withSettings = (root) => {
	fs.mkdirSync(path.join(root, '.vscode'), { recursive: true });
	fs.writeFileSync(path.join(root, '.vscode', 'settings.json'), '{\n  "dreamteamer.navHidden": ["fixas"]\n}\n');
	git(root, ['add', '-f', '.vscode/settings.json']);
	git(root, ['commit', '-qm', 'old nav settings']);
};
const RUNNABLE = 'npx -p @dreamteamer/protocol@0.3 dt-nav migrate';
function assertRunnableLine(stderr) {
	const line = stderr.split('\n').find((l) => l.includes('nav.yaml yet'));
	assert.ok(line, `a nav refusal line on stderr: ${stderr}`);
	assert.ok(line.includes(RUNNABLE), `names the published protocol: ${line}`);
	assert.match(line, /the editor 0\.27 or later/, line);
	assert.doesNotMatch(line, /protocol@0\.2\b|editor 0\.26\b/, line);
	// the protocol version it names resolves to one npm holds (0.0.0-stage, 0.1.0, 0.1.1, 0.3.0)
	const v = /@dreamteamer\/protocol@([0-9.]+)/.exec(line)[1];
	assert.ok(['0.3', '0.3.0'].includes(v), v);
}

describe('held-out 0.49.1 — the nav refusal names versions that exist', () => {
	test('dt install of a module preset with old nav settings: the binary prints the runnable command and writes nothing', () => {
		const ws = offline();
		withSettings(ws.root);
		const before = treeHash(ws.root);
		const r = run(ws.root, ['install', '@fix/set@1.0.0', '--from', REG]);
		assert.equal(r.code, 1, r.stderr + r.stdout);
		assertRunnableLine(r.stderr);
		assert.equal(treeHash(ws.root), before, 'nothing written');
	});
	test('dt update of a plain module with old nav settings: the same runnable command', () => {
		const ws = offline();
		const i = run(ws.root, ['install', '@fix/a@1.0.0', '--from', REG]);
		assert.equal(i.code, 0, i.stderr + i.stdout);
		withSettings(ws.root);
		const pkg = readFile(ws.root, 'package.json');
		const r = run(ws.root, ['update', '@fix/a', '--from', REG]);
		assert.equal(r.code, 1, r.stderr + r.stdout);
		assertRunnableLine(r.stderr);
		assert.equal(readFile(ws.root, 'package.json'), pkg, 'the pin did not move');
	});
	test('the release is 0.49.1: package.json, both lockfile root entries and dt version agree', () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(ENGINE_ROOT, 'package.json'), 'utf8'));
		const lock = JSON.parse(fs.readFileSync(path.join(ENGINE_ROOT, 'package-lock.json'), 'utf8'));
		assert.equal(pkg.version, '0.49.1');
		assert.equal(lock.version, '0.49.1');
		assert.equal(lock.packages[''].version, '0.49.1');
		const v = spawnSync(process.execPath, [BIN, 'version'], { cwd: os.tmpdir(), encoding: 'utf8', env: ENV, timeout: 60_000 });
		assert.match(`${v.stdout}${v.stderr}`, /\b0\.49\.1\b/);
	});
});
