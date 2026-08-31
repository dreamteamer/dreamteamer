#!/usr/bin/env node
// TIER 4 — the perf harness. Zero dependencies, `node:` builtins only, and OPT-IN:
//
//   npm run perf                        renameCollection, 200 records, seconds
//   npm run perf -- --records=2291      the original measurement (minutes — see below)
//   npm run perf -- --filler=1100       records in the OTHER collection, i.e. the M in O(N x M)
//   npm run perf -- --keep              leave the generated workspace under test/.perf/ to poke at
//
// ⚠ NOT ON `npm test` OR `npm run verify`, ever, and it PRINTS rather than ASSERTS. A timing is a
// property of the machine that took it, so a perf run that gates a build fails on a loaded laptop
// and teaches everyone to ignore red. Tiers 1-3 are in `scripts/test.mjs`; this is the fourth of the
// same kind, and the same promise runs through all four: the default path stays fast enough to run
// before every commit.
//
// WHY IT GENERATES ITS FIXTURE INSTEAD OF SHIPPING ONE. The finding this harness exists to reproduce
// was measured on a real, private workspace, and the comment describing it named that workspace — so
// nobody else could re-run it, and the only durable record of a real number was prose. A generated
// fixture inverts that: `--records=N` builds N records here, now, on your disk. Nothing is committed
// (`test/.perf/` is gitignored) and nothing ships (`test/` is outside package.json's `files`).
//
// GENERATION IS MEASURED TOO, and not as a courtesy. Building the fixture is N writes through the
// real Store — schema validation, id generation, frontmatter serialisation, one file each — so its
// records/sec is the engine's write path under a load no hand-made test reaches.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../../src/compile.js';
import { Store } from '../../src/store.js';
import { renameCollection } from '../../src/schema-ops.js';
import { dump } from '../../src/yaml.js';

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PERF_DIR = path.join(ENGINE_ROOT, 'test', '.perf');
const BIN = path.join(ENGINE_ROOT, 'bin', 'dreamteamer.js');

const args = process.argv.slice(2);
const flag = (n) => args.some((a) => a === `--${n}`);
const num = (n, d) => Number(args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? d);

const RECORDS = num('records', 200);
// The original shape was 2,291 records inside 3,391 record files, i.e. ~48% of the walk is OTHER
// collections' records that can never match. Default to the same ratio so a small run and a big one
// describe the same curve.
const FILLER = num('filler', Math.round(RECORDS * 0.48));
// A handful of real inbound references, so the run proves the rewrite WORKS as well as timing it.
// The point of the original finding is that the cost is identical when this is zero.
const REFS = Math.min(3, FILLER);
// The second measurement's scale: N related pairs, all of them dirty, none of them published. This
// is the term `dt commit <collection>` used to pay a git subprocess for, twice over, per row.
const PAIRS = num('pairs', 200);

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: 'dreamteamer perf', GIT_AUTHOR_EMAIL: 'perf@example.invalid',
	GIT_COMMITTER_NAME: 'dreamteamer perf', GIT_COMMITTER_EMAIL: 'perf@example.invalid',
};
const git = (root, a) => execFileSync('git', a, { cwd: root, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

const LEDGER = {
	id: { generate: '{{ name | slug }}' },
	storage: { suffix: 'entry' },
	schema: {
		type: 'object', required: ['name'],
		properties: { name: { type: 'string' }, amount: { type: 'number' }, note: { type: 'string' } },
	},
};
const FILLER_COLL = {
	id: { generate: '{{ name | slug }}' },
	storage: { suffix: 'memo' },
	schema: {
		type: 'object', required: ['name'],
		properties: { name: { type: 'string' }, entry: { type: 'string', 'x-reference': 'ledger' } },
	},
};

// A relation, declared the way a real one is: the scalar side owns it, the array side is generated.
// `notes` is x-body on BOTH because compile refuses to stamp a mirror onto a codec: md collection
// that declares no body — a mirror write rebuilds the file from its parsed fields and would drop any
// prose the record holds.
const CALLS = {
	id: { generate: '{{ name | slug }}' },
	storage: { suffix: 'call' },
	schema: {
		type: 'object', required: ['name'],
		properties: { name: { type: 'string' }, notes: { type: 'string', format: 'markdown', 'x-body': true } },
	},
};
const CAPTURES = {
	id: { generate: '{{ name | slug }}' },
	storage: { suffix: 'cap' },
	schema: {
		type: 'object', required: ['name'],
		properties: {
			name: { type: 'string' },
			notes: { type: 'string', format: 'markdown', 'x-body': true },
			call: { type: 'string', 'x-reference': 'calls', 'x-inverse': 'captures' },
		},
	},
};

const secs = (ms) => `${(ms / 1000).toFixed(2)}s`;
const rate = (n, ms) => `${Math.round(n / (ms / 1000)).toLocaleString()}/sec`;

/** A real workspace with N ledger records and FILLER memos, built through init + compile + Store. */
function generate() {
	fs.rmSync(PERF_DIR, { recursive: true, force: true });
	const root = path.join(PERF_DIR, `ws-${RECORDS}x${FILLER}`);
	fs.mkdirSync(root, { recursive: true });

	const t0 = performance.now();
	// `git init` BEFORE `dreamteamer init`, for the reason test/helpers/ws.js states at length: init
	// commits what it writes and git walks UPWARD, so with no repo here the fixture lands in the
	// engine's own history.
	git(root, ['init', '-q']);
	git(root, ['config', 'user.email', 'perf@example.invalid']);
	git(root, ['config', 'user.name', 'dreamteamer perf']);
	const res = spawnSync(process.execPath, [BIN, 'init'], { cwd: root, env: GIT_ENV, encoding: 'utf8' });
	if (res.status !== 0) throw new Error(`perf fixture init failed:\n${res.stdout}\n${res.stderr}`);

	// the engine as an INSTALLED module — a symlink, on the npm channel, same as the tier-2 fixture
	fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
	fs.symlinkSync(ENGINE_ROOT, path.join(root, 'node_modules', 'dreamteamer'), 'dir');
	const pkgFile = path.join(root, 'package.json');
	const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
	pkg.dependencies = { ...pkg.dependencies, dreamteamer: '*' };
	pkg.dreamteamer.namespaces = ['finance'];
	fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, '\t') + '\n');

	const collDir = path.join(root, 'modules', 'default', 'collections');
	fs.mkdirSync(collDir, { recursive: true });
	fs.writeFileSync(path.join(collDir, 'ledger.collection.yaml'), dump({ name: 'ledger', ...LEDGER }));
	fs.writeFileSync(path.join(collDir, 'memos.collection.yaml'), dump({ name: 'memos', ...FILLER_COLL }));

	const ws = { root, pkg };
	const tCompile = performance.now();
	const log = console.log, warn = console.warn;
	console.log = console.warn = () => {};
	try { compile(ws); } finally { console.log = log; console.warn = warn; }
	const compileMs = performance.now() - tCompile;

	const store = new Store(ws);
	const tWrite = performance.now();
	const ids = [];
	for (let i = 0; i < RECORDS; i++) {
		ids.push(store.add('ledger', { name: `Entry ${i}`, amount: i * 1.5, note: `row ${i}` }).id);
	}
	for (let i = 0; i < FILLER; i++) {
		// only the first REFS memos point at the ledger; the rest are the dead weight the walk still reads
		store.add('memos', { name: `Memo ${i}`, ...(i < REFS ? { entry: `ledger/${ids[i]}` } : {}) });
	}
	const writeMs = performance.now() - tWrite;

	git(root, ['add', '-A']);
	git(root, ['commit', '-qm', 'perf: fixture']);
	const totalMs = performance.now() - t0;

	// M is not "files in the workspace" but what the ref walk actually reads: every record file of
	// every collection, the compiled-source ones included. Ask the store rather than guessing.
	const files = [...new Store({ root, pkg }).recordFiles()].length;
	return { root, ws, files, compileMs, writeMs, totalMs };
}

/** Time `renameCollection`, counting the file reads it does. */
function timeRename(ws) {
	const store = new Store(ws);
	const real = fs.readFileSync;
	let reads = 0;
	// `import fs from 'node:fs'` is the same mutable default export in every src/ module, so a counter
	// here sees store.js's and schema-ops.js's reads both. This is why the O(N x M) claim can be a
	// measurement instead of an argument.
	fs.readFileSync = (...a) => { reads++; return real(...a); };
	// a rename recompiles, and compile is chatty — the recompile is PART of the cost being measured,
	// so it still runs; only its output is swallowed, so the report stays one block.
	const log = console.log, warn = console.warn;
	console.log = console.warn = () => {};
	const cpu0 = process.cpuUsage();
	const t0 = performance.now();
	let out;
	try {
		out = renameCollection(ws, store, 'ledger', 'finance/ledger');
	} finally {
		fs.readFileSync = real;
		console.log = log;
		console.warn = warn;
	}
	const wallMs = performance.now() - t0;
	const cpu = process.cpuUsage(cpu0);
	return { out, reads, wallMs, userMs: cpu.user / 1000, sysMs: cpu.system / 1000 };
}

/** A workspace of PAIRS related records — one capture per call — published, then every record on
 *  BOTH sides dirtied with prose. Prose is the point: no edge moves, so the leftover warning has
 *  nothing to say and pays in full to find that out. That is the shape the regression lived in. */
function commitFixture() {
	const root = path.join(PERF_DIR, `commit-${PAIRS}`);
	fs.mkdirSync(root, { recursive: true });
	git(root, ['init', '-q']);
	git(root, ['config', 'user.email', 'perf@example.invalid']);
	git(root, ['config', 'user.name', 'dreamteamer perf']);
	const res = spawnSync(process.execPath, [BIN, 'init'], { cwd: root, env: GIT_ENV, encoding: 'utf8' });
	if (res.status !== 0) throw new Error(`perf fixture init failed:\n${res.stdout}\n${res.stderr}`);
	fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
	fs.symlinkSync(ENGINE_ROOT, path.join(root, 'node_modules', 'dreamteamer'), 'dir');
	const pkgFile = path.join(root, 'package.json');
	const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
	pkg.dependencies = { ...pkg.dependencies, dreamteamer: '*' };
	fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, '\t') + '\n');
	const collDir = path.join(root, 'modules', 'default', 'collections');
	fs.mkdirSync(collDir, { recursive: true });
	fs.writeFileSync(path.join(collDir, 'calls.collection.yaml'), dump({ name: 'calls', ...CALLS }));
	fs.writeFileSync(path.join(collDir, 'captures.collection.yaml'), dump({ name: 'captures', ...CAPTURES }));

	const ws = { root, pkg };
	const log = console.log, warn = console.warn;
	console.log = console.warn = () => {};
	try { compile(ws); } finally { console.log = log; console.warn = warn; }

	const store = new Store(ws);
	const t0 = performance.now();
	let first;
	for (let i = 0; i < PAIRS; i++) {
		// bodies of differing length, so nothing downstream can be right by accident on fixed-size rows
		const call = store.add('calls', { name: `Call ${i}`, notes: 'x'.repeat((i % 20) * 40 + 1) });
		const cap = store.add('captures', { name: `Cap ${i}`, call: `calls/${call.id}` });
		first ??= cap.id;
	}
	const writeMs = performance.now() - t0;
	git(root, ['add', '-A']);
	git(root, ['commit', '-qm', 'perf: fixture']);
	for (const c of ['calls', 'captures']) {
		const dir = path.join(root, 'data', c);
		for (const f of fs.readdirSync(dir)) fs.appendFileSync(path.join(dir, f), '\nsession B was here.\n');
	}
	return { root, first, writeMs };
}

/** Wall time of one CLI invocation. The CLI, not the export, because the whole cost being measured is
 *  SUBPROCESSES and the ~90ms of node startup in here is the floor every row is counted against. */
function timeCli(root, args) {
	const t0 = performance.now();
	const res = spawnSync(process.execPath, [BIN, ...args], { cwd: root, env: GIT_ENV, encoding: 'utf8' });
	const ms = performance.now() - t0;
	if (res.status !== 0) throw new Error(`${args.join(' ')} failed:\n${res.stdout}\n${res.stderr}`);
	return ms;
}

console.log(`\n  dreamteamer perf — tier 4, opt-in, timings only (nothing here can fail a build)\n`);
console.log(`  GENERATING  ledger ${RECORDS.toLocaleString()} records · memos ${FILLER.toLocaleString()} records · ${REFS} inbound refs`);
const fixture = generate();
console.log(`    fixture           ${secs(fixture.totalMs)}  (init + compile + ${(RECORDS + FILLER).toLocaleString()} writes + one commit)`);
console.log(`    compile           ${secs(fixture.compileMs)}`);
console.log(`    ${(RECORDS + FILLER).toLocaleString()} record writes  ${secs(fixture.writeMs)}   ${rate(RECORDS + FILLER, fixture.writeMs)} through the real Store`);
console.log(`    record files (M)  ${fixture.files.toLocaleString()}   — what one ref pass reads`);
console.log(`\n  The write rate above is the whole point of measuring generation. \`add\` needs the ids that`);
console.log(`  already exist to generate one that is unique, so it calls \`ids()\` — which asked`);
console.log(`  \`git rev-parse HEAD\` for its cache key and then re-walked the collection from disk,`);
console.log(`  because the PREVIOUS add had deleted the memo it was about to rebuild. A run of adds paid`);
console.log(`  both, per record. Measured on an M-series Mac, 2026-09-01, --records=400 --filler=100:`);
console.log(`    memo deleted per add, HEAD dropped per lock     88/sec   11.3ms per record`);
console.log(`    index maintained, HEAD dropped by commits    1,581/sec    0.63ms per record`);
console.log(`  The split, isolated by pinning one memo at a time: of 10.7ms per add, 9.9ms was the`);
console.log(`  subprocess and 0.68ms the walk. An add with an EXPLICIT id, which calls neither, cost`);
console.log(`  0.18ms throughout, before and after — and that is the floor the other two sit on. The`);
console.log(`  walk is the term that GROWS with the collection; the spawn was the flat floor under it.\n`);

console.log(`  RENAME  ledger → finance/ledger`);
const r = timeRename(fixture.ws);
console.log(`    wall              ${secs(r.wallMs)}`);
console.log(`    user / system     ${secs(r.userMs)} / ${secs(r.sysMs)}`);
console.log(`    per record        ${(r.wallMs / RECORDS).toFixed(1)}ms   (N=${RECORDS})`);
console.log(`    file reads        ${r.reads.toLocaleString()}   ≈ ${fixture.files.toLocaleString()} files x 2 ref passes`);
console.log(`    refs rewritten    ${r.out.rewrites ?? '?'}   — the reads above are paid whether this is ${r.out.rewrites} or 0`);
console.log(`\n  O(files) now, and it was O(records x files) TWICE: one pass per id to snapshot the inbound`);
console.log(`  refs for rollback, one more per id to rewrite them, whether or not anything pointed at the`);
console.log(`  collection. \`store.rewriteRefsBatch\` opens each record file once and applies every`);
console.log(`  old→new pair to the bytes in hand, and the snapshot pass is gone entirely because the`);
console.log(`  rewrite snapshots what it writes as it writes it. What is left is that one pass plus the`);
console.log(`  \`collections/<name>\` retarget, which is a second mechanism and still its own walk.`);
console.log(`  Measured on an M-series Mac, best of three:`);
console.log(`    --records=400 --filler=100    504 files    6.39s  410,678 reads  (2026-09-01, per id)`);
console.log(`    --records=400 --filler=100    504 files    0.16s    1,075 reads  (2026-09-01, batched)`);
console.log(`    --records=2291 --filler=1100  3,395 files   271s    15.6M reads  (2026-08-22, per id)`);

console.log(`\n  COMMIT  ${PAIRS} related pairs, all dirty on BOTH sides, none published`);
const cf = commitFixture();
console.log(`    ${(PAIRS * 2).toLocaleString()} record writes  ${secs(cf.writeMs)}   ${rate(PAIRS * 2, cf.writeMs)} through the real Store`);
// One row per FORM, because the point of the measurement is that only one of the three asks the
// question — and a reader who cannot see the other two flat has no way to tell a real regression
// from a slow machine.
for (const [args, what] of [
	[['commit', 'captures', '--dry-run'], 'whole-collection: warns about the partners it leaves'],
	[['commit', `captures/${cf.first}`, '--dry-run'], 'record-scoped: sweeps, so it can leave none behind'],
	[['commit', '--dry-run'], 'unscoped: publishes everything, nothing is left'],
]) {
	console.log(`    ${args.join(' ').padEnd(34)}${secs(timeCli(cf.root, args))}   ${what}`);
}
console.log(`\n  The whole-collection form is the one that asks a question per DIRTY ROW: "did your edge`);
console.log(`  move to something I am publishing". Each answer used to cost two git subprocesses — a`);
console.log(`  \`git show\` for the pre-image and a \`rev-parse HEAD\` inside the store's id-cache key —`);
console.log(`  so the form scaled at ~20ms per dirty partner row while the other two stayed flat.`);
console.log(`  Measured on an M-series Mac, 2026-08-31, --pairs=200, best of three:`);
console.log(`    per-row \`git show\` + per-row store.read   4.14s   what it cost`);
console.log(`    batched pre-images only                   2.08s`);
console.log(`    worktree read off the row only            2.20s`);
console.log(`    both                                     0.15s   and flat in the row count`);
console.log(`  The tempting rewrite — ask each PUBLISHED row instead — is in neither column: it costs`);
console.log(`  4.16s here (publishing N rows is what dirtied N partners, so the two sides are the same`);
console.log(`  size) and 4.20s with no dirty partners at all, where this measures 0.10s. It also names a`);
console.log(`  different set; src/commit.js says why, and two tests hold it.`);

// ── the id index's own key ─────────────────────────────────────────────────────────────────────
// Reuses the COMMIT fixture rather than generating a third: PAIRS captures each carrying one `call`
// reference is exactly the shape a one-hop relational filter is paid for — one referenced record
// resolved per row, and `store.read` goes through the id index.
console.log(`\n  FILTER  one-hop relational --where over ${PAIRS.toLocaleString()} captures`);
const filterMs = timeCli(cf.root, ['list', 'captures', '--where', '{"call":{"name":{"_nnull":true}}}']);
console.log(`    list captures --where …           ${secs(filterMs)}   ${(filterMs / PAIRS).toFixed(1)}ms per row`);
console.log(`\n  The id index is memoized per collection on (HEAD sha, dir mtime) — and \`ids()\` used to ask`);
console.log(`  \`git rev-parse HEAD\` on EVERY call, hit or miss. So the subprocess was the cost of the`);
console.log(`  CACHE rather than of the walk it avoids: one ~10ms spawn per resolved reference. HEAD is`);
console.log(`  now read once per Store and dropped by withWriteLock, which is where anything that can`);
console.log(`  move it happens. Measured on an M-series Mac, 2026-08-31, --pairs=200, best of three:`);
console.log(`    rev-parse per ids() call   2.39s   11.9ms per row — one spawn each`);
console.log(`    HEAD memoized per Store    0.08s    0.4ms per row — one spawn total`);
console.log(`  The profile that found it: 1,525ms of a 1,677ms command, on a workspace of 4,186 records.`);

if (flag('keep')) console.log(`\n  kept: ${path.relative(ENGINE_ROOT, fixture.root)} · ${path.relative(ENGINE_ROOT, cf.root)}`);
else fs.rmSync(PERF_DIR, { recursive: true, force: true });
console.log('');
