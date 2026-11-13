// HELD-OUT (rnd/tests/dreamteamer/heldout-doctor-secret-tilde) — reviewer-written for rnd/implementation-plans/2026-11-13--dt-doctor-drops-a-refused-secret-path-as-status-does.
// A ~/-relative secret-path is expanded against the home folder before the rule is applied — a loose file is refused for its mode, never mistaken for a missing one.
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

describe('held-out: dt doctor expands a ~/ secret-path before judging it', () => {
	test('PROBE_TOKEN_PATH=~/.secrets/tok at 0644 is refused for its mode (not "no such file"); at 0600 it is ok', { skip: !POSIX && 'no mode check on win32' }, () => {
		const ws = probed();
		const home = path.join(ws.root, '.home');   // run() hands the CLI this HOME
		const tok = tokenFile(path.join(home, '.secrets', 'tok'), 0o644);
		const env = { PROBE_TOKEN_PATH: '~/.secrets/tok' };
		const cap = doctorProbe(ws.root, env);
		const row = refusedRow(cap.checks, /readable by other users — chmod 600/);
		assert.ok(row, `no refused row in ${JSON.stringify(cap.checks)}`);
		assert.equal(row.state, 'warn');
		assert.match(String(row.detail), /\.secrets[\\/]tok/);
		assert.ok(!cap.checks.some((c) => /no such file/.test(String(c.detail))), 'the ~ was expanded, so the file was found: ' + JSON.stringify(cap.checks));
		assert.ok(!cap.checks.some((c) => /present \(never read\)/.test(String(c.detail))), 'the unit never saw the refused value');
		fs.chmodSync(tok, 0o600);
		const ok = doctorProbe(ws.root, env);
		assert.ok(!ok.checks.some((c) => /readable by other users|no such file|not a file/.test(String(c.detail))), JSON.stringify(ok.checks));
		assert.ok(ok.checks.some((c) => c.state === 'ok' && /present \(never read\)/.test(String(c.detail))), JSON.stringify(ok.checks));
	});
});
