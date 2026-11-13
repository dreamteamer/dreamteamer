// The engine performs a unit's env action (cr-dt-007, D61): through the real binary, against the
// synthetic provider whose make-home is now `env: { PROBE_HOME, PROBE_LABEL }` with no apply branch.
// Plan-time refusals read blocked at exit 0 with nothing written; a file that moved between the plan
// and the write is a failure at exit 1 (D57); the value never prints; the fix line prints whole (D67);
// an apply-less unit's non-env action fails by name; ctx.dt per driver matches the written table.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { workspace, withProbeSetup, ENGINE_ROOT, readFile, git } from '../helpers/ws.js';
import { buildRegistry } from '../fixtures/registry/build.mjs';

// a workspace whose engine is a file: dependency, so `dt install … --from` resolves everything from disk
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

const BIN = path.join(ENGINE_ROOT, 'bin', 'dreamteamer.js');
const run = (root, args, env = {}) => {
	const home = path.join(root, '.home');
	fs.mkdirSync(home, { recursive: true });
	const r = spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL', env: { PATH: process.env.PATH, HOME: home, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', ...env } });
	return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', home };
};
const probed = () => { const ws = workspace({ compile: false }); withProbeSetup(ws.root); git(ws.root, ['add', '-A']); git(ws.root, ['commit', '-qm', 'fixture: probe']); const c = run(ws.root, ['compile']); assert.equal(c.code, 0, c.stderr); return ws; };
const SECRET = 'hunter2-value-never-printed';

describe('an env action, performed by the engine', () => {
	test('writes .env through the engine, never prints the value, reads done on the second run; the fix line prints whole', () => {
		const ws = probed();
		const r = run(ws.root, ['setup', 'probe', '--input', `label=${SECRET}`]);
		assert.equal(r.code, 0, r.stderr + r.stdout);
		assert.match(r.stdout, /✔ make-home — wrote \.env \(PROBE_HOME, PROBE_LABEL\)/);
		assert.doesNotMatch(r.stdout + r.stderr, new RegExp(SECRET));
		assert.match(readFile(ws.root, '.env'), new RegExp(`^PROBE_LABEL=${SECRET}$`, 'm'));
		assert.match(readFile(ws.root, '.env'), /^PROBE_HOME=/m);
		const j = run(ws.root, ['setup', 'probe', '--input', `label=${SECRET}`, '--json']);
		assert.equal(j.code, 0);
		assert.doesNotMatch(j.stdout, new RegExp(SECRET), 'the value is absent from --json too');
		assert.doesNotMatch(j.stdout, /make-home.*wrote/, 'nothing applied the second time');
		// the unit's own fix line, with its <placeholder>, survives redaction on the status board
		const s = run(ws.root, ['status'], { PROBE_HOME: ws.root, PROBE_LABEL: '' });   // home present, so the label row's fix is the next command
		assert.match(s.stdout, /dt setup probe --input label=<label>/);
	});

	test('a ready env action\'s reason is printed after the write — the unit says what it left out', () => {
		const ws = probed();
		const r = run(ws.root, ['setup', 'probe', '--input', 'label=demo'], { PROBE_NOTE: '1' });
		assert.equal(r.code, 0, r.stderr + r.stdout);
		assert.match(r.stdout, /✔ make-home — wrote \.env \(PROBE_HOME, PROBE_LABEL\) — row input 2 skipped: not a row/);
	});

	test('git would commit .env: blocked at plan time, exit 0, nothing written', () => {
		const ws = probed();
		fs.writeFileSync(path.join(ws.root, '.gitignore'), readFile(ws.root, '.gitignore').replace(/^\.env\n/m, ''));
		git(ws.root, ['add', '-A']); git(ws.root, ['commit', '-qm', 'unignore .env']);
		const r = run(ws.root, ['setup', 'probe', '--input', 'label=demo']);
		assert.equal(r.code, 0, r.stderr + r.stdout);
		assert.match(r.stdout, /… make-home \(blocked\) — git would commit \.env — add it to \.gitignore first/);
		assert.ok(!fs.existsSync(path.join(ws.root, '.env')), 'nothing written');
	});

	test('a pending env action never carries its values: --json lists the keys it would write, not what', () => {
		const ws = probed();
		fs.writeFileSync(path.join(ws.root, '.gitignore'), readFile(ws.root, '.gitignore').replace(/^\.env\n/m, ''));
		git(ws.root, ['add', '-A']); git(ws.root, ['commit', '-qm', 'unignore .env']);
		const r = run(ws.root, ['setup', 'probe', '--input', `label=${SECRET}`, '--json']);
		assert.equal(r.code, 0, r.stderr);
		assert.ok(!r.stdout.includes(SECRET), 'the value is not in --json');
		const pending = JSON.parse(r.stdout).units[0].pending.find((p) => p.id === 'make-home');
		assert.equal(pending.state, 'blocked');
		assert.deepEqual(pending.env, ['PROBE_HOME', 'PROBE_LABEL']);
	});

	test('.env moved between the plan and the write: failed, exit 1 (D57)', () => {
		const ws = probed();
		const r = run(ws.root, ['setup', 'probe', '--input', 'label=demo'], { PROBE_TOUCH_ENV: '1' });
		assert.equal(r.code, 1, r.stderr + r.stdout);
		assert.match(r.stdout, /✖ make-home — \.env changed after the preview — nothing was written; plan again/);
		assert.doesNotMatch(readFile(ws.root, '.env'), /PROBE_LABEL/);
	});

	test('an apply-less unit: its env action runs; a non-env action fails by name', () => {
		const ws = probed();
		const r = run(ws.root, ['setup', 'probe', '--input', 'label=demo'], { PROBE_NOAPPLY: '1', PROBE_EXTRA: '1' });
		assert.equal(r.code, 1, r.stderr + r.stdout);
		assert.match(r.stdout, /✔ make-home — wrote \.env/);
		assert.match(r.stdout, /✖ extra — unit probe: action extra carries no env and the unit declares no apply/);
	});

	test('dt install runs the env action too, and commits nothing of .env', () => {
		const ws = offline();
		const r = run(ws.root, ['install', '@probe/setup', '--from', buildRegistry(), '--input', 'label=demo', '--no-input']);
		assert.ok([0, 3].includes(r.code), r.stderr + r.stdout);
		assert.match(r.stdout, /✔ make-home — wrote \.env \(PROBE_HOME, PROBE_LABEL\)/);
		assert.match(readFile(ws.root, '.env'), /^PROBE_LABEL=demo$/m);
		assert.equal(git(ws.root, ['ls-files', '--', '.env']), '', '.env is not tracked');
	});

	test('ctx.dt per driver: the engine\'s API under dt setup and dt doctor, null under dt install and dt status', () => {
		const ws = offline();
		const log = path.join(ws.root, 'ctx.log');
		const env = { PROBE_CTX_LOG: log };
		// install first: the probe is the fresh unit, so install's own driver runs its inspect
		const i = run(ws.root, ['install', '@probe/setup', '--from', buildRegistry(), '--no-input'], env);
		assert.ok([0, 3].includes(i.code), i.stderr + i.stdout);
		run(ws.root, ['setup', 'probe', '--input', 'label=demo'], env);
		run(ws.root, ['doctor'], env);
		run(ws.root, ['status'], env);
		const seen = Object.fromEntries(fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split('=')));
		assert.equal(seen.setup, 'object');
		assert.equal(seen.doctor, 'object');
		assert.equal(seen.status, 'null');
		assert.equal(seen.install, 'null');
	});
});
