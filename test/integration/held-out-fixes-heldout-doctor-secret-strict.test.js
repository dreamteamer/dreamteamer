// HELD-OUT (rnd/tests/dreamteamer/heldout-doctor-secret-strict) — reviewer-written for rnd/implementation-plans/2026-11-13--dt-doctor-drops-a-refused-secret-path-as-status-does.
// dt doctor --strict with a unit whose only fault is a refused secret-path: DEGRADED (a warning, per the plan's architecture), exit 0 — and no longer READY.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { workspace, withProbeSetup, ENGINE_ROOT, git } from '../helpers/ws.js';

const BIN = path.join(ENGINE_ROOT, 'bin', 'dreamteamer.js');
const POSIX = process.platform !== 'win32';
// the same runner status-setup.test.js uses: a private HOME under the workspace, nothing else from the caller's env
const run = (root, args, env = {}) => {
	const home = path.join(root, '.home');
	fs.mkdirSync(home, { recursive: true });
	const r = spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL', env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', ...env } });
	return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};
const probed = () => {
	const ws = workspace({ compile: false });
	withProbeSetup(ws.root);
	git(ws.root, ['add', '-A']); git(ws.root, ['commit', '-qm', 'fixture: probe']);
	const c = run(ws.root, ['compile']);
	assert.equal(c.code, 0, c.stderr);
	return ws;
};
const tokenFile = (file, mode) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'x'); fs.chmodSync(file, mode); return file; };
/** The probe capability of `dt doctor --json`. */
const doctorProbe = (root, env = {}, extra = []) => {
	const d = run(root, ['doctor', '--json', ...extra], env);
	assert.equal(d.code, 0, d.stderr);
	const cap = JSON.parse(d.stdout).capabilities.find((c) => c.name === 'probe');
	assert.ok(cap, `no probe capability in ${d.stdout}`);
	return cap;
};
/** The probe line of `dt status --json`'s setup section. */
const statusProbe = (root, env = {}) => {
	const s = run(root, ['status', '--json'], env);
	assert.equal(s.code, 0, s.stderr);
	const l = JSON.parse(s.stdout).setup.find((x) => x.unit === 'probe');
	assert.ok(l, `no probe line in ${s.stdout}`);
	return l;
};
const refusedRow = (rows, re) => rows.find((r) => re.test(String(r.detail ?? '')));

/** A probe with every check ready: the safe part, the consequential effects and the live check, with an owner-only token. */
const readyProbe = () => {
	const ws = probed();
	const tok = tokenFile(path.join(ws.root, 'secrets', 'tok'), 0o600);
	const home = path.join(ws.root, 'phome');
	const env = { PROBE_TOKEN_PATH: tok };
	assert.equal(run(ws.root, ['setup', 'probe', '--input', 'label=d', '--input', `home=${home}`, '--allow', 'download', '--allow', 'machine'], env).code, 0);
	assert.equal(run(ws.root, ['setup', 'probe', '--input', 'label=d', '--input', `home=${home}`, '--verify', '--allow', 'machine'], env).code, 0);
	return { ws, tok, env };
};

describe('held-out: dt doctor --strict with only a refused secret-path against the unit', () => {
	test('0600: READY, exit 0. 0644: DEGRADED (never READY), the refused row a warning, exit 0 — text and --json agree', { skip: !POSIX && 'no mode check on win32' }, () => {
		const { ws, tok, env } = readyProbe();
		const good = run(ws.root, ['doctor', '--strict'], env);
		assert.equal(good.code, 0, good.stderr);
		assert.match(good.stdout, /probe — READY/);
		fs.chmodSync(tok, 0o644);
		const loose = run(ws.root, ['doctor', '--strict'], env);
		assert.equal(loose.code, 0, 'a refused secret-path is a warning (missing → warn): --strict fails only on UNAVAILABLE\n' + loose.stdout + loose.stderr);
		assert.match(loose.stdout, /probe — DEGRADED/);
		assert.doesNotMatch(loose.stdout, /probe — READY/);
		assert.match(loose.stdout, / {2}⚠ token file {2}.*tok is readable by other users — chmod 600 /);
		const j = run(ws.root, ['doctor', '--strict', '--json'], env);
		assert.equal(j.code, 0, j.stderr);
		const cap = JSON.parse(j.stdout).capabilities.find((c) => c.name === 'probe');
		assert.equal(cap.verdict, 'DEGRADED');
		const bad = cap.checks.filter((c) => c.state !== 'ok');
		assert.ok(bad.length >= 1 && bad.every((c) => c.state === 'warn'), JSON.stringify(cap.checks));
		assert.ok(refusedRow(bad, /readable by other users — chmod 600/), JSON.stringify(bad));
	});
});
