#!/usr/bin/env node
// The test runner. Zero dependencies — node:test and nothing else.
//
//   npm test                     tiers 1+2, dot reporter, seconds
//   npm test -- --only=namespace  just the files whose path contains "namespace"
//   npm test -- --unit            tier 1 only (pure functions, no fs, no git)
//   npm test -- --verbose         spec reporter, every test name
//   npm test -- --name=overlap    node's --test-name-pattern, for one assertion
//
// WHY A RUNNER SCRIPT AND NOT JUST `node --test`: the default reporter prints a paragraph per
// passing test, which is the single fastest way to make a test suite something people stop reading.
// `dot` prints one character per test and the FULL detail of every failure — so a green run costs
// four lines and a red run tells you everything. That is the whole difference between a suite that
// gets run before every commit and one that gets run in CI while everybody ignores it.
//
// The tiers are a promise about SPEED, and the promise is what keeps the suite in the loop:
//   tier 1  test/unit/         pure functions. No workspace, no git, no subprocess.
//   tier 2  test/integration/  a real compiled workspace per file, driven through the real
//                              engine functions and the real CLI binary.
//   tier 3  the extension repo's `npm run test:ui` — boots VS Code, opt-in, never on this path.
import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.some((a) => a === `--${name}`);
const value = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const only = value('only');
const namePattern = value('name');
const tiers = flag('unit') ? ['unit'] : flag('integration') ? ['integration'] : ['unit', 'integration'];

// A stale fixture is the one failure mode a cached workspace can introduce, so make discarding it
// trivial and obvious rather than something you have to know to do.
if (flag('clean')) {
	rmSync(join(ROOT, 'test', '.tmp'), { recursive: true, force: true });
	console.log('✔ removed test/.tmp — the next run rebuilds every fixture');
}

const files = [];
for (const tier of tiers) {
	const dir = join(ROOT, 'test', tier);
	if (!existsSync(dir)) continue;
	for (const name of readdirSync(dir).sort()) {
		if (!name.endsWith('.test.js')) continue;
		const rel = join('test', tier, name);
		if (only && !rel.includes(only)) continue;
		files.push(rel);
	}
}

if (!files.length) {
	console.error(only ? `✖ no test files match --only=${only}` : '✖ no test files found');
	process.exit(1);
}

const reporter = flag('verbose') ? 'spec' : join(ROOT, 'scripts', 'test-reporter.mjs');
// A FILE that hangs is a FAILURE, never a wait. `--test-timeout` bounds each top-level test, and
// with files on the command line a top-level test IS a file — so this is a per-file cap. Ten
// minutes: measured 2026-09-24, the slowest file alone is prove at 75 s, land 53 s, commit 43 s,
// and under 8-way concurrency they run ~3× slower (120 s cut all three off). Per-COMMAND timers
// live in test/helpers/ws.js (SPAWN_TIMEOUT_MS); this is the backstop above them.
const nodeArgs = ['--test', `--test-reporter=${reporter}`, '--test-timeout=600000'];
if (namePattern) nodeArgs.push(`--test-name-pattern=${namePattern}`);
// Concurrency is the other half of "fast": tier-2 files each build their own workspace, and those
// builds are independent. One process per file, as many at once as there are cores.
if (!flag('serial')) nodeArgs.push('--test-concurrency=' + Math.max(2, Math.min(8, (await import('node:os')).cpus().length - 1)));

const res = spawnSync(process.execPath, [...nodeArgs, ...files], { cwd: ROOT, stdio: 'inherit' });
process.exit(res.status ?? 1);
