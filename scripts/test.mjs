#!/usr/bin/env node
// The test runner. Zero dependencies — node:test and nothing else.
//
//   npm test                     tiers 1+2, dot reporter, seconds
//   npm test -- --only=namespace  just the files whose path contains "namespace"
//   npm test -- --unit            tier 1 only (pure functions, no fs, no git)
//   npm test -- --verbose         spec reporter, every test name
//   npm test -- --name=overlap    node's --test-name-pattern, for one assertion
//   npm test -- --changed         tier 1 + the tier-2 files the working-tree diff names (verify:fast)
//   npm test -- --failed          just the files that failed on their last run
//   npm test -- --rerun           a full run even when this exact tree already passed one
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
import { spawnSync, execFileSync } from 'node:child_process';
import { readdirSync, existsSync, rmSync, readFileSync, writeFileSync, mkdirSync, statSync, copyFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { selectTests } from './test-select.mjs';

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

const TMP = join(ROOT, 'test', '.tmp');
// Written by scripts/test-reporter.mjs after every run: the files whose last run failed.
const FAILED_FILE = join(TMP, 'last-failed.json');
const readFailed = () => { try { return JSON.parse(readFileSync(FAILED_FILE, 'utf8')); } catch { return []; } };

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

if (flag('failed')) {
	const failed = new Set(readFailed());
	files.splice(0, files.length, ...files.filter((f) => failed.has(f)));
	if (!files.length) { console.log('✔ nothing failed on its last run'); process.exit(0); }
}

if (flag('changed')) {
	// Tier 1 always (it is under a second); tier 2 only where the diff points. Never the gate.
	const changed = gitLines(['diff', '--name-only', 'HEAD']).concat(gitLines(['ls-files', '--others', '--exclude-standard']));
	const integration = new Map(files.filter((f) => f.startsWith(join('test', 'integration')))
		.map((f) => [f, readFileSync(join(ROOT, f), 'utf8')]));
	const pick = selectTests({ changed, integration, failed: readFailed() });
	const keep = new Set(pick.files);
	files.splice(0, files.length, ...files.filter((f) => !integration.has(f) || keep.has(f)));
	console.log(`fast tier — ${changed.length} changed path(s); tier 1 + ${pick.all ? 'ALL' : pick.files.length} tier-2 file(s):`);
	if (!pick.all) for (const [f, why] of pick.reasons) console.log(`  ${f}  (${why})`);
	else console.log(`  everything (${[...pick.reasons.values()][0]} changed)`);
	console.log('  not the gate: run `npm run verify` once, before the commit\n');
}

if (!files.length) {
	console.error(only ? `✖ no test files match --only=${only}` : '✖ no test files found');
	process.exit(1);
}

// A FULL run (every file, no name filter) is the only one worth remembering: it is the gate. Its
// key is the working tree itself — a throwaway index, `git add -A`, `write-tree` — so tracked edits,
// untracked files and deletions all change it, and nothing else does. Plus the node version, because
// the same tree on another runtime is another experiment.
const isFull = !only && !namePattern && !flag('unit') && !flag('integration') && !flag('changed') && !flag('failed');
const stampDir = join(TMP, 'passed');
const treeKey = isFull ? workingTreeKey() : null;
const stampFile = treeKey && join(stampDir, treeKey);
const reportStamp = () => {
	if (!stampFile || flag('rerun') || !existsSync(stampFile)) return false;
	const st = JSON.parse(readFileSync(stampFile, 'utf8'));
	console.log(`✔ the full suite already passed on this exact working tree — exit 0 at ${st.at}, ${st.seconds}s, ${st.files} files.`);
	console.log('  not re-run (any edit, new file or deletion changes the key; --rerun forces a run)');
	return true;
};
if (reportStamp()) process.exit(0);

// One tier-2 suite at a time on this MACHINE, across clones and worktrees: two 7-way suites on one
// laptop measured 466 s against 211 s alone (2026-10-01), and each made the other's timeouts
// flakier. A second run waits, then re-checks the stamp — the run it waited on may have been this
// very tree. Tier 1 alone takes no lock; it is under a second.
const needsLock = files.some((f) => f.startsWith(join('test', 'integration')));
if (needsLock && !flag('no-lock')) {
	acquireLock();
	if (reportStamp()) process.exit(0);
	sweepLeakedFixtures();
}

// a URL, not a path: on Windows an absolute path is not a module specifier ('d:' reads as a scheme)
const reporter = flag('verbose') ? 'spec' : pathToFileURL(join(ROOT, 'scripts', 'test-reporter.mjs')).href;
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

const started = Date.now();
const res = spawnSync(process.execPath, [...nodeArgs, ...files], { cwd: ROOT, stdio: 'inherit' });
if (res.status === 0 && stampFile && workingTreeKey() === treeKey) {
	// Re-keyed AFTER the run: an edit made while the suite ran means it did not test this tree.
	mkdirSync(stampDir, { recursive: true });
	writeFileSync(stampFile, JSON.stringify({ at: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000), files: files.length }) + '\n');
}
process.exit(res.status ?? 1);

function gitLines(args) {
	return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 30_000 }).split('\n').filter(Boolean);
}

function workingTreeKey() {
	const index = join(tmpdir(), `dt-test-index-${process.pid}`);
	try {
		// Starting from a copy of the real index keeps git's stat cache, so this costs one status walk.
		const real = resolve(ROOT, execFileSync('git', ['rev-parse', '--git-path', 'index'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 }).trim());
		if (existsSync(real)) copyFileSync(real, index);
		const env = { ...process.env, GIT_INDEX_FILE: index };
		execFileSync('git', ['add', '-A'], { cwd: ROOT, env, timeout: 60_000 });
		const tree = execFileSync('git', ['write-tree'], { cwd: ROOT, env, encoding: 'utf8', timeout: 30_000 }).trim();
		return createHash('sha256').update(`${tree}\n${process.version}`).digest('hex').slice(0, 24);
	} catch {
		return null; // not a git checkout (a tarball): no memory, every run is real
	} finally {
		rmSync(index, { force: true });
	}
}

function acquireLock() {
	// DT_TEST_LOCK_DIR exists for the runner's own tests, which must not queue behind the suite running them.
	const lock = join(process.env.DT_TEST_LOCK_DIR ?? tmpdir(), 'dreamteamer-engine-suite.lock');
	const owner = join(lock, 'owner.json');
	const WAIT_MS = 20 * 60_000; // a hang upstream is a failure with a message, never an endless wait
	const deadline = Date.now() + WAIT_MS;
	let told = false;
	for (;;) {
		try {
			mkdirSync(lock);
			writeFileSync(owner, JSON.stringify({ pid: process.pid, root: ROOT, args, at: new Date().toISOString() }));
			const release = () => rmSync(lock, { recursive: true, force: true });
			process.on('exit', release);
			for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { release(); process.exit(1); });
			return;
		} catch (e) {
			if (e.code !== 'EEXIST') throw e;
		}
		let held;
		try { held = JSON.parse(readFileSync(owner, 'utf8')); } catch { held = null; }
		const alive = held && (() => { try { process.kill(held.pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } })();
		// No owner file yet is a lock mid-creation — unless it is old, in which case its creator died there.
		const stale = held ? !alive : Date.now() - statSync(lock, { throwIfNoEntry: false })?.mtimeMs > 10_000;
		if (stale) { rmSync(lock, { recursive: true, force: true }); continue; }
		if (!told && held) {
			console.log(`… waiting for the engine suite already running (pid ${held.pid}, ${held.root}, since ${held.at})`);
			told = true;
		}
		if (Date.now() > deadline) {
			console.error(`✖ waited ${WAIT_MS / 60_000} min for the suite lock at ${lock}; still held. --no-lock runs anyway.`);
			process.exit(1);
		}
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
	}
}

// A run killed by a timeout never reaches the fixtures' exit-time cleanup, so its workspaces stay —
// 1,186 of them, 1.2 GB, were found on 2026-10-01. Under the lock no other suite on this machine is
// writing fixtures, so anything older than an hour is a leftover.
function sweepLeakedFixtures() {
	if (!existsSync(TMP)) return;
	const cutoff = Date.now() - 60 * 60_000;
	for (const name of readdirSync(TMP)) {
		if (!/^(ws|ws2|bare|staging|shadow)-/.test(name)) continue;
		const p = join(TMP, name);
		try { if (statSync(p).mtimeMs < cutoff) rmSync(p, { recursive: true, force: true }); } catch { /* raced */ }
	}
}
