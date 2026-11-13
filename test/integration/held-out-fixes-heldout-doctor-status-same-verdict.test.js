// HELD-OUT (rnd/tests/dreamteamer/heldout-doctor-status-same-verdict) — reviewer-written for rnd/implementation-plans/2026-11-13--dt-doctor-drops-a-refused-secret-path-as-status-does.
// dt doctor and dt status read one workspace the same way: the same refused secret-path rows in the same words, and ready ⇔ READY, across every secret-path state.
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

const REFUSED = /readable by other users|: not a file|: no such file/;

describe('held-out: doctor and status agree on one workspace', () => {
	test('for an owner-only, a loose, a directory, a missing and an unset secret-path: the same refused rows, and status ready exactly when doctor is READY', () => {
		const ws = probed();
		const tok = tokenFile(path.join(ws.root, 'secrets', 'tok'), 0o600);
		const home = path.join(ws.root, 'phome');
		assert.equal(run(ws.root, ['setup', 'probe', '--input', 'label=d', '--input', `home=${home}`, '--allow', 'download', '--allow', 'machine'], { PROBE_TOKEN_PATH: tok }).code, 0);
		assert.equal(run(ws.root, ['setup', 'probe', '--input', 'label=d', '--input', `home=${home}`, '--verify', '--allow', 'machine'], { PROBE_TOKEN_PATH: tok }).code, 0);
		const loose = tokenFile(path.join(ws.root, 'secrets', 'loose'), 0o644);
		const dir = path.join(ws.root, 'secrets', 'a-folder'); fs.mkdirSync(dir, { recursive: true });
		if (POSIX) fs.chmodSync(dir, 0o700);
		const cases = [
			['owner-only', tok, false],
			...(POSIX ? [['loose', loose, true]] : []),
			['directory', dir, true],
			['missing', path.join(ws.root, 'secrets', 'gone'), true],
		];
		for (const [label, value, refused] of cases) {
			const env = { PROBE_TOKEN_PATH: value };
			const s = statusProbe(ws.root, env);
			const d = doctorProbe(ws.root, env);
			const sRows = s.checks.filter((c) => REFUSED.test(String(c.detail ?? ''))).map((c) => c.detail).sort();
			const dRows = d.checks.filter((c) => REFUSED.test(String(c.detail ?? ''))).map((c) => c.detail).sort();
			assert.deepEqual(dRows, sRows, `${label}: doctor and status refuse the same values in the same words`);
			assert.equal(sRows.length > 0, refused, `${label}: refused=${refused} (status ${JSON.stringify(s.checks)})`);
			assert.equal(s.state === 'ready', d.verdict === 'READY', `${label}: status ${s.state}, doctor ${d.verdict}`);
			assert.equal(d.verdict === 'READY', !refused, `${label}: a refused secret-path never reads READY (${d.verdict})`);
		}
	});
});
