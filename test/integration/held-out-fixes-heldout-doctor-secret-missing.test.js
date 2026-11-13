// HELD-OUT (rnd/tests/dreamteamer/heldout-doctor-secret-missing) — reviewer-written for rnd/implementation-plans/2026-11-13--dt-doctor-drops-a-refused-secret-path-as-status-does.
// A secret-path whose file does not exist is refused by dt doctor ("no such file") as dt status refuses it — every platform.
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

describe('held-out: dt doctor refuses a secret-path whose file is missing', () => {
	test('PROBE_TOKEN_PATH=<no such file>: one warning row "no such file" with the fix, in text and --json; status carries the same row', () => {
		const ws = probed();
		const gone = path.join(ws.root, 'nowhere', 'tok');
		const env = { PROBE_TOKEN_PATH: gone };
		const cap = doctorProbe(ws.root, env);
		const row = refusedRow(cap.checks, /: no such file/);
		assert.ok(row, `no refused row in ${JSON.stringify(cap.checks)}`);
		assert.equal(row.state, 'warn');
		assert.match(String(row.fix), /^dt setup probe --input token=/);
		const text = run(ws.root, ['doctor'], env);
		assert.equal(text.code, 0, text.stderr);
		assert.match(text.stdout, / {2}⚠ token file {2}.*tok: no such file — fix: dt setup probe --input token=/);
		const s = statusProbe(ws.root, env);
		assert.equal(refusedRow(s.checks, /: no such file/)?.detail, row.detail, 'status and doctor name the same problem in the same words');
	});
});
