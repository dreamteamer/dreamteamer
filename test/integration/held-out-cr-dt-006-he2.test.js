// held-out cr-dt-006-he2 — --input values holding '=', a leading '--', and a unicode path reach the unit
// intact. rnd/tests/cr-dt-006-he2.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initialized, setupPackage, installPackage, applyLog, folder, dt, cleanup } from './held-out-cr-dt-006-lib.js';

after(cleanup);

test('he2: rows=a=b|c is one row split on the first = only; a unicode home lands in .env byte for byte; --not-a-flag is a value', () => {
	const root = initialized({ name: 'he2' });
	installPackage(root, setupPackage({ name: '@heldout/probe', unit: 'probe', env: ['PROBE_TOKEN_PATH'], vars: ['PROBE_HOME'], inputs: [
		{ id: 'home', kind: 'path', env: 'PROBE_HOME', required: true, default: '~/.cache/probe', title: 'probe home' },
		{ id: 'token', kind: 'secret-path', env: 'PROBE_TOKEN_PATH', required: false, title: 'token file' },
		{ id: 'rows', kind: 'rows', title: 'rows', rows: { columns: ['name', 'value'] } },
	] }));
	assert.equal(dt(root, ['compile']).code, 0);
	const home = path.join(folder('uni'), 'ünïcödé 目录');
	// the token value starts with `--`: it is a secret-path, so (since 688b5f9) it must name an existing owner-only
	// file — one literally called `--not-a-flag` in the workspace root, which is where dt runs
	fs.writeFileSync(path.join(root, '--not-a-flag'), 'x', { mode: 0o600 }); fs.chmodSync(path.join(root, '--not-a-flag'), 0o600);
	const r = dt(root, ['setup', 'probe', '--input', 'rows=a=b|c', '--input', `home=${home}`, '--input', 'token=--not-a-flag', '--allow', 'machine', '--json']);
	assert.equal(r.code, 0, r.stderr + r.stdout);
	assert.doesNotMatch(r.stderr, /unknown flag/, 'a value starting with -- is a value');
	const j = JSON.parse(r.stdout);
	assert.ok(j.workspace?.root, 'the JSON result names workspace.root');
	const log = applyLog(root, 'probe');
	assert.equal(log.length, 1, 'make-home applied once');
	assert.deepEqual(log[0].inputs.rows, ['a=b|c'], 'the rows value is split on the first = only');
	assert.deepEqual(log[0].inputs.rows[0].split('|'), ['a=b', 'c'], 'the row has the two declared columns');
	assert.equal(log[0].inputs.token, '--not-a-flag');
	assert.equal(log[0].inputs.home, home);
	const env = fs.readFileSync(path.join(root, '.env'));
	assert.ok(env.includes(Buffer.from(`PROBE_HOME=${home}\n`)), `.env holds the unicode path byte for byte: ${env.toString()}`);
	assert.ok(fs.existsSync(home) && fs.statSync(home).isDirectory(), 'the folder exists');
});
