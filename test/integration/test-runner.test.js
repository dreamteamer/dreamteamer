// The runner's memory and manners (scripts/test.mjs): a full pass is remembered for the exact working
// tree, `--failed` reruns only what failed, and a second suite queues behind the first instead of
// halving both. Driven against a scratch repo carrying a copy of the three scripts and two trivial test
// files, because running the real suite inside the real suite would be the very cost this removes.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ENGINE_ROOT, SPAWN_TIMEOUT_MS } from '../helpers/ws.js';

function scratch() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-runner-'));
	fs.mkdirSync(path.join(root, 'scripts'));
	for (const f of ['test.mjs', 'test-select.mjs', 'test-reporter.mjs']) fs.copyFileSync(path.join(ENGINE_ROOT, 'scripts', f), path.join(root, 'scripts', f));
	fs.mkdirSync(path.join(root, 'test', 'unit'), { recursive: true });
	fs.mkdirSync(path.join(root, 'test', 'integration'), { recursive: true });
	write(root, 'test/unit/a.test.js', "import { test } from 'node:test'; test('a', () => {});\n");
	write(root, 'test/integration/b.test.js', "import { test } from 'node:test'; test('b', () => {});\n");
	fs.writeFileSync(path.join(root, '.gitignore'), 'test/.tmp/\n');
	const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-runner-lock-'));
	execFileSync('git', ['init', '-q'], { cwd: root });
	return { root, lockDir };
}
const write = (root, rel, text) => fs.writeFileSync(path.join(root, rel), text);
// NODE_TEST_CONTEXT is what this file's own runner sets on its children; inherited, it turns the inner
// `node --test` into a subtest that exits 0 on a red file — the outer run would then pass on a lie.
const env = (lockDir) => {
	const { NODE_TEST_CONTEXT, ...rest } = process.env;
	return { ...rest, DT_TEST_LOCK_DIR: lockDir, NO_COLOR: '1' };
};
const runner = ({ root, lockDir }, ...args) => spawnSync(process.execPath, ['scripts/test.mjs', ...args],
	{ cwd: root, env: env(lockDir), encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS, killSignal: 'SIGKILL' });

describe('a full pass is remembered for the exact working tree', () => {
	test('the second run on an unchanged tree is served from the stamp; any edit runs it again', () => {
		const s = scratch();
		const first = runner(s);
		assert.equal(first.status, 0, first.stdout + first.stderr);
		assert.doesNotMatch(first.stdout, /already passed/);

		const second = runner(s);
		assert.equal(second.status, 0);
		assert.match(second.stdout, /already passed on this exact working tree/);

		write(s.root, 'test/unit/a.test.js', "import { test } from 'node:test'; test('a, edited', () => {});\n");
		const third = runner(s);
		assert.equal(third.status, 0);
		assert.doesNotMatch(third.stdout, /already passed/, 'an untracked edit changes the key');

		assert.doesNotMatch(runner(s, '--rerun').stdout, /already passed/, '--rerun always runs');
	});

	test('a red run leaves no stamp, and a narrower run never writes one', () => {
		const s = scratch();
		write(s.root, 'test/integration/b.test.js', "import { test } from 'node:test'; test('b', () => { throw new Error('red'); });\n");
		assert.equal(runner(s).status, 1);
		assert.equal(runner(s).status, 1, 'still red: nothing remembered');

		write(s.root, 'test/integration/b.test.js', "import { test } from 'node:test'; test('b', () => {});\n");
		assert.equal(runner(s, '--only=b').status, 0);
		assert.doesNotMatch(runner(s).stdout, /already passed/, 'the --only pass was not the gate');
	});
});

describe('--failed reruns exactly what failed last', () => {
	test('a failing file is remembered until it runs green', () => {
		const s = scratch();
		write(s.root, 'test/integration/b.test.js', "import { test } from 'node:test'; test('b', () => { throw new Error('red'); });\n");
		assert.equal(runner(s).status, 1);
		const failed = JSON.parse(fs.readFileSync(path.join(s.root, 'test/.tmp/last-failed.json'), 'utf8'));
		assert.deepEqual(failed, ['test/integration/b.test.js']);

		assert.equal(runner(s, '--unit').status, 0);
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.root, 'test/.tmp/last-failed.json'), 'utf8')), failed,
			'a run that never touched the file keeps it on the list');

		write(s.root, 'test/integration/b.test.js', "import { test } from 'node:test'; test('b', () => {});\n");
		const rerun = runner(s, '--failed');
		assert.equal(rerun.status, 0);
		assert.match(rerun.stdout, /1\/1 passed/, 'only the failed file ran');
		assert.match(runner(s, '--failed').stdout, /nothing failed on its last run/);
	});
});

describe('one tier-2 suite per machine', () => {
	test('a second run waits for the first, naming it', async () => {
		const s = scratch();
		const lock = path.join(s.lockDir, 'dreamteamer-engine-suite.lock');
		fs.mkdirSync(lock);
		fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, root: '/elsewhere', at: 'earlier' }));

		const child = spawn(process.execPath, ['scripts/test.mjs'], { cwd: s.root, env: env(s.lockDir) });
		let out = '';
		child.stdout.on('data', (d) => { out += d; });
		let exited = false;
		const done = new Promise((r) => child.on('exit', (code) => { exited = true; r(code); }));
		const timer = setTimeout(() => child.kill('SIGKILL'), SPAWN_TIMEOUT_MS);
		// Bounded by the child: a runner that never waits must fail this test, not hang it.
		while (!/waiting for the engine suite/.test(out) && !exited) await new Promise((r) => setTimeout(r, 100));
		assert.match(out, /waiting for the engine suite/, 'the run went ahead while another held the lock');
		assert.match(out, new RegExp(`pid ${process.pid}`));
		assert.doesNotMatch(out, /passed/, 'nothing ran while the lock was held');

		fs.rmSync(lock, { recursive: true, force: true });
		const code = await done;
		clearTimeout(timer);
		assert.equal(code, 0, out);
		assert.match(out, /all passed/);
		assert.ok(!fs.existsSync(lock), 'released on exit');
	});

	test('a lock whose owner is dead is reclaimed without waiting', () => {
		const s = scratch();
		const dead = spawnSync(process.execPath, ['-e', '0']).pid;
		const lock = path.join(s.lockDir, 'dreamteamer-engine-suite.lock');
		fs.mkdirSync(lock);
		fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: dead, root: '/elsewhere', at: 'earlier' }));
		const r = runner(s);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.doesNotMatch(r.stdout, /waiting/);
	});
});
