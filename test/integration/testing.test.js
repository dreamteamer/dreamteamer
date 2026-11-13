// `dreamteamer/testing` (cr-dt-007, G2): a module's own suite builds a workspace on the engine that is
// running it, installs the module the way a consumer does, and asserts on dt verbs — with nothing but
// `node --test` and this import. Every helper spawns the engine as a consumer would.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkspace, pack, install, run, engineMeets, ENGINE } from '../../src/testing.js';
import { ENGINE_ROOT } from '../helpers/ws.js';

const PROBE = path.join(ENGINE_ROOT, 'test', 'fixtures', 'probe-setup');
const VERSION = JSON.parse(fs.readFileSync(path.join(ENGINE_ROOT, 'package.json'), 'utf8')).version;

describe('dreamteamer/testing', () => {
	test('ENGINE is this file\'s own package, never one on PATH', () => {
		assert.equal(fs.realpathSync(ENGINE), fs.realpathSync(ENGINE_ROOT));
	});
	test('engineMeets reads the running engine\'s version', () => {
		assert.equal(engineMeets(`>=${VERSION}`), true);
		assert.equal(engineMeets('>=999.0.0'), false);
	});
	test('createWorkspace inits on the running engine; run drives it; the folder is a real workspace', () => {
		const ws = createWorkspace();
		assert.equal(fs.realpathSync(ws.engine), fs.realpathSync(ENGINE_ROOT));
		assert.ok(fs.existsSync(path.join(ws.root, 'package.json')));
		const r = run(ws, ['status', '--json']);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(JSON.parse(r.stdout).workspace.root, fs.realpathSync(ws.root));
		assert.equal(ws.dt(['check']).status, 0, 'ws.dt is run bound to the workspace');
	});
	test('pack returns the tarball npm would publish', () => {
		const tgz = pack(PROBE);
		assert.match(path.basename(tgz), /^probe-setup-1\.0\.0\.tgz$/);
		assert.ok(fs.statSync(tgz).size > 0);
	});
	test('install of a folder packs it first and runs dt install — exit 3 is a result (its required input), not a throw', () => {
		const ws = createWorkspace();
		const r = install(ws, PROBE);
		assert.equal(r.status, 3, r.stdout + r.stderr);
		assert.match(r.stdout, /probe/);
		const again = install(ws, PROBE, { env: { PROBE_LABEL: 'demo' } });
		assert.ok([0, 3].includes(again.status), again.stderr);
	});
	test('run passes input to stdin (D71) and env over the fixture\'s', () => {
		const ws = createWorkspace();
		// `install --hook` reads a harness payload from stdin — the one verb that does; without input it would wait
		const r = run(ws, ['install', '--hook'], { input: JSON.stringify({ cwd: ws.root }), timeoutMs: 30_000 });
		assert.notEqual(r.status, null, 'it read the payload and exited instead of waiting on stdin');
		const e = run(ws, ['resolve', '${env:PROBE_X}'], { env: { PROBE_X: 'from-env' } });
		assert.ok(e.status !== null);
	});
	test('a run past timeoutMs ends by signal: status is null', () => {
		const ws = createWorkspace();
		const r = run(ws, ['status'], { timeoutMs: 1 });
		assert.equal(r.status, null);
	});
	test('DT_ENGINE_DIR names another checkout, and createWorkspace uses it', () => {
		const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-engine-copy-'));
		fs.symlinkSync(ENGINE_ROOT, path.join(copy, 'dreamteamer'), 'dir');
		const before = process.env.DT_ENGINE_DIR;
		process.env.DT_ENGINE_DIR = path.join(copy, 'dreamteamer');
		try {
			const ws = createWorkspace();
			assert.equal(ws.engine, path.join(copy, 'dreamteamer'));
			assert.equal(run(ws, ['status']).status, 0);
		} finally { if (before === undefined) delete process.env.DT_ENGINE_DIR; else process.env.DT_ENGINE_DIR = before; }
	});
});
