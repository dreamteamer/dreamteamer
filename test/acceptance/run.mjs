#!/usr/bin/env node
// The design's acceptance matrix, run as the commands a person types — see README.md beside this file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = path.resolve(HERE, '..', '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ENGINE_ROOT, 'package.json'), 'utf8')).version;
const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3); };
const ONLY = (arg('only') ?? '').split(',').filter(Boolean);
const DRIVER = arg('driver') ?? path.join(ENGINE_ROOT, 'bin', 'dreamteamer.js');
const OUT = arg('out') ?? path.join(HERE, 'out', new Date().toISOString().slice(0, 10));
let FROM = arg('from') ?? process.env.DT_CANDIDATES ?? null;

// ---- the folder of tarballs: the fixtures, and the engine itself, when nobody handed one in ----
import { buildRegistry } from '../fixtures/registry/build.mjs';
if (!FROM) FROM = buildRegistry();
// the folder handed in is read, never written: its tarballs are copied into a temp folder, and the
// fixtures and (when absent) the engine are packed THERE
const GIVEN = path.resolve(FROM);
FROM = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-acceptance-from-'));
for (const f of fs.readdirSync(GIVEN).filter((f) => f.endsWith('.tgz'))) fs.copyFileSync(path.join(GIVEN, f), path.join(FROM, f));
const tgzs = () => fs.readdirSync(FROM).filter((f) => f.endsWith('.tgz'));
if (!tgzs().some((f) => f === `dreamteamer-${VERSION}.tgz`)) {
	const r = spawnSync('npm', ['pack', ENGINE_ROOT, '--pack-destination', FROM, '--silent'], { encoding: 'utf8' });
	if (r.status !== 0) throw new Error(`npm pack of the engine failed: ${r.stderr}`);
}
if (!tgzs().some((f) => f.startsWith('fix-a-'))) buildRegistry(FROM);
fs.mkdirSync(OUT, { recursive: true });
const sha = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
fs.writeFileSync(path.join(OUT, 'SHA256SUMS'), tgzs().sort().map((f) => `${sha(path.join(FROM, f))}  ${f}`).join('\n') + '\n');

// ---- the sandbox: a temp HOME, the stand-ins first on PATH, git identity, npm fenced ----
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dt-acceptance-')));
// realpath: google-workspace refuses a credential store whose path passes through a symlink, and macOS's tmp does
const HOME = fs.realpathSync((() => { const h = path.join(SANDBOX, 'home'); fs.mkdirSync(h); return h; })());
const ENV = { PATH: `${path.join(HERE, 'bin')}:${process.env.PATH}`, HOME, GIT_AUTHOR_NAME: 'acceptance', GIT_AUTHOR_EMAIL: 'acceptance@example.invalid', GIT_COMMITTER_NAME: 'acceptance', GIT_COMMITTER_EMAIL: 'acceptance@example.invalid', GIT_CEILING_DIRECTORIES: os.tmpdir(), npm_config_cache: path.join(SANDBOX, 'npm-cache'), npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' };
// ⚠ npm's registry is NOT fenced here: the engine tarball's own dependencies (ajv, js-yaml, …) come from
// it — public packages, the same ones a person's npm fetches. Every MODULE comes from the --from folder;
// a module name the folder lacks is a refusal, never a registry lookup (the fixture registry proves it).
const TRANSCRIPT = path.join(OUT, 'transcript.jsonl'); fs.writeFileSync(TRANSCRIPT, '');
let n = 0;
const fresh = (name) => { const d = path.join(SANDBOX, `${++n}-${name}`); fs.mkdirSync(d); return d; };
/** One command the person would type, recorded. */
function dt(cwd, args, env = {}) {
	const r = spawnSync(process.execPath, [DRIVER, ...args], { cwd, env: { ...ENV, ...env }, encoding: 'utf8', timeout: 300_000 });
	const rec = { cwd: path.relative(SANDBOX, cwd), cmd: `dt ${args.join(' ')}`, code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
	fs.appendFileSync(TRANSCRIPT, JSON.stringify(rec) + '\n');
	return rec;
}
const git = (cwd, args) => spawnSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).stdout.trim();
function treeHash(root) {
	const h = createHash('sha256');
	const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { if (e.name === '.git') continue; const p = path.join(dir, e.name); if (e.isSymbolicLink()) h.update(`L ${p} ${fs.readlinkSync(p)}`); else if (e.isDirectory()) walk(p); else { h.update(`F ${p}`); h.update(fs.readFileSync(p)); } } };
	walk(root); return h.digest('hex');
}
const index = Object.fromEntries(tgzs().map((f) => { const m = /^(.*)-(\d+\.\d+\.\d+[^/]*)\.tgz$/.exec(f); return [m?.[1], f]; }));
const REAL = ['@dreamteamer/tasks', '@dreamteamer/contacts', '@dreamteamer/meetings', '@dreamteamer/recordings', '@dreamteamer/google-workspace'];
const realHere = REAL.filter((name) => index[name.replace('@', '').replace('/', '-')]);
const withProbe = realHere.length < REAL.length;

// ---- scenarios ----
const results = [];
const scenario = (id, title, fn) => { if (ONLY.length && !ONLY.includes(id)) return; const checks = []; const ok = (cond, what) => { checks.push({ what, ok: !!cond }); if (!cond) console.log(`  ✖ ${id}: ${what}`); }; try { fn(ok); } catch (e) { checks.push({ what: `threw: ${e.message}`, ok: false }); console.log(`  ✖ ${id} threw: ${e.message}`); } const pass = checks.every((c) => c.ok); results.push({ id, title, pass, checks }); console.log(`${pass ? '✔' : '✖'} ${id} ${title}`); };
const initArgs = ['init', '--from', FROM];

scenario('A1', 'empty folder → init → install → status, every line exit 0, second run changes nothing', (ok) => {
	const root = fresh('a1');
	const r0 = dt(root, initArgs); ok(r0.code === 0, `init exit ${r0.code}: ${r0.stderr}`);
	ok(fs.existsSync(path.join(root, '.git')), 'a repository was created');
	const lines = withProbe
		? [['install', '@fix/a', '@fix/b', '--from', FROM], ['install', '@probe/setup', '--from', FROM, '--input', 'label=probe', '--input', `home=${path.join(HOME, 'probe')}`, '--allow', 'download', '--allow', 'machine']]
		: [['install', '@dreamteamer/tasks', '@dreamteamer/contacts', '--from', FROM], ['install', '@dreamteamer/meetings', '--from', FROM, '--input', 'calendar=sample@example.com|mixed|sample@example.com'], ['install', '@dreamteamer/recordings', '--from', FROM, '--input', `files_folder=${path.join(HOME, 'hq-files')}`, '--input', `transcription_home=${path.join(HOME, 'transcription')}`, '--allow', 'download', '--allow', 'machine'], ['install', '@dreamteamer/google-workspace', '--from', FROM, '--input', `credentials_dir=${path.join(HOME, 'google-credentials')}`, '--allow', 'machine']];
	for (const l of lines) { const r = dt(root, l); ok(r.code === 0, `${l.join(' ')} exit ${r.code}: ${r.stderr}${r.stdout.slice(-300)}`); }
	const s = dt(root, ['status']); ok(s.code === 0 && /setup:/.test(s.stdout), 'status prints the setup section');
	ok(git(root, ['status', '--porcelain']) === '', 'nothing left uncommitted');
	fs.copyFileSync(path.join(root, '.dreamteamer', 'manifest.yaml'), path.join(OUT, 'a1-manifest.yaml'));
	fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(OUT, 'a1-package-lock.json'));
	const before = treeHash(root);
	dt(root, initArgs); for (const l of lines) dt(root, l);
	ok(treeHash(root) === before, 'a second identical run changed nothing');
});

scenario('A2', 'core then tasks, and tasks then core, refused before npm naming the pair', (ok) => {
	const core = withProbe ? '@fix/core' : '@dreamteamer/core', small = withProbe ? '@fix/a' : '@dreamteamer/tasks';
	// the real core composes recordings, whose files_folder is required with no default: without a terminal the
	// install exits 3 (needs input) unless the folder is given — so it is, as a script would
	const a = fresh('a2a'); dt(a, initArgs); ok(dt(a, ['install', core, '--from', FROM, '--input', `files_folder=${path.join(HOME, 'hq-files')}`]).code === 0, 'core installs');
	const h = treeHash(a); const r = dt(a, ['install', small, '--from', FROM]);
	ok(r.code === 1 && /already provides/.test(r.stderr), `refused naming core: ${r.stderr}`); ok(treeHash(a) === h, 'nothing written');
	const b = fresh('a2b'); dt(b, initArgs); ok(dt(b, ['install', small, '--from', FROM]).code === 0, 'small installs');
	const hb = treeHash(b); const rb = dt(b, ['install', core, '--from', FROM]);
	ok(rb.code === 1 && /provides .* which is installed/.test(rb.stderr), `refused naming the small module: ${rb.stderr}`); ok(treeHash(b) === hb, 'nothing written');
});

scenario('A3', 'a required input missing without a TTY: exit 3 and JSON names it; with --input it completes', (ok) => {
	const root = fresh('a3'); dt(root, initArgs);
	const r = dt(root, ['install', '@probe/setup', '--from', FROM, '--json']);
	ok(r.code === 3, `exit ${r.code}`);
	let j = null; try { j = JSON.parse(r.stdout); } catch { /* not json */ }
	ok(j?.units?.[0]?.needs?.includes('label'), 'JSON names label');
	const s = dt(root, ['status']); ok(/probe\s+configured/.test(s.stdout), 'status says configured');
	const f = dt(root, ['setup', 'probe', '--input', 'label=probe', '--no-input']); ok(f.code === 0 && /make-home/.test(f.stdout), 'the same with --input completes');
});

scenario('A4', 'download waits for --allow, then configured; --verify writes the receipt and status reads ready · verified', (ok) => {
	const root = fresh('a4'); dt(root, initArgs);
	const tok = path.join(HOME, 'probe-token'); fs.writeFileSync(tok, 'x', { mode: 0o600 }); fs.chmodSync(tok, 0o600);   // a secret-path must be owner-only
	const env = { PROBE_TOKEN_PATH: tok };
	const home = path.join(HOME, 'a4-probe');
	const r = dt(root, ['install', '@probe/setup', '--from', FROM, '--input', 'label=probe', '--input', `home=${home}`], env);
	ok(r.code === 0 && /… fetch \(needs --allow download\)/.test(r.stdout), 'download pending without --allow');
	ok(!fs.existsSync(path.join(home, 'weights.txt')), 'nothing downloaded');
	const d = dt(root, ['setup', 'probe', '--input', 'label=probe', '--input', `home=${home}`, '--allow', 'download', '--allow', 'machine'], env);
	ok(d.code === 0 && fs.existsSync(path.join(home, 'weights.txt')), 'downloaded with --allow');
	ok(/probe\s+configured\s+live check unverified/.test(dt(root, ['status'], env).stdout), 'configured, live check unverified');
	const before = treeHash(root); dt(root, ['doctor'], env); ok(treeHash(root) === before, 'doctor wrote nothing');
	const v = dt(root, ['setup', 'probe', '--input', 'label=probe', '--input', `home=${home}`, '--verify', '--allow', 'machine'], env);
	ok(v.code === 0 && /ready · verified \d{4}-\d{2}-\d{2}/.test(v.stdout), `verified: ${v.stdout}`);
	ok(/probe\s+ready · verified/.test(dt(root, ['status'], env).stdout), 'status reads ready · verified');
});

scenario('A5', 'an install interrupted after npm finishes on re-run; a third run changes nothing', (ok) => {
	const root = fresh('a5'); dt(root, initArgs);
	// the interruption: npm's work left on disk, the runtime not compiled (what a kill between the two leaves)
	const r = spawnSync('npm', ['install', '--save-exact', '--no-audit', '--no-fund', path.join(FROM, index['fix-b'])], { cwd: root, env: ENV, encoding: 'utf8' });
	ok(r.status === 0, 'npm put the module in place');
	ok(!fs.existsSync(path.join(root, '.dreamteamer', 'collections', 'fixbs.collection.yaml')), 'not compiled');
	const again = dt(root, ['install', '@fix/b', '--from', FROM]);
	ok(again.code === 0 && fs.existsSync(path.join(root, '.dreamteamer', 'collections', 'fixbs.collection.yaml')), 'the re-run compiled');
	ok(git(root, ['status', '--porcelain']) === '', 'and committed');
	const before = treeHash(root); dt(root, ['install', '@fix/b', '--from', FROM]); ok(treeHash(root) === before, 'a third run changed nothing');
});

scenario('A6', 'a provider that throws leaves its unit blocked and the rest intact; a compile refusal restores the pre-image', (ok) => {
	const root = fresh('a6'); dt(root, initArgs);
	// since 0.48.0 make-home is the engine's own .env write (cr-dt-007), so the first apply the probe runs is the consented download
	const r = dt(root, ['install', '@probe/setup', '--from', FROM, '--input', 'label=probe', '--allow', 'download'], { PROBE_THROW: 'apply' });
	ok(r.code === 1 && /✖ probe: blocked/.test(r.stdout) && /token=\[redacted\]/.test(r.stdout) && !/hunter2/.test(r.stdout), 'blocked, redacted, exit 1 (D57: a failed apply is a failure; the install itself stands)');
	ok(dt(root, ['check']).code === 0, 'the workspace still checks');
	const pkg = fs.readFileSync(path.join(root, 'package.json'), 'utf8'), lock = fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8');
	const mods = fs.readdirSync(path.join(root, 'node_modules')).sort().join(',');
	const c = dt(root, ['install', '@probe/collide', '--from', FROM]);
	ok(c.code === 1 && /install refused: compile error: name collision/.test(c.stderr), 'compile refusal');
	ok(fs.readFileSync(path.join(root, 'package.json'), 'utf8') === pkg && fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8') === lock && fs.readdirSync(path.join(root, 'node_modules')).sort().join(',') === mods, 'package.json, lockfile and node_modules restored');
});

scenario('A7', 'a synthetic provider is driven with no engine edit', (ok) => {
	// the probe is a package in test/fixtures; the engine's src/ names no module — the proof is the grep
	const src = fs.readdirSync(path.join(ENGINE_ROOT, 'src')).map((f) => fs.readFileSync(path.join(ENGINE_ROOT, 'src', f), 'utf8')).join('\n');
	ok(!/@probe\/|['"`]probe['"`]|google-workspace|@dreamteamer\/(meetings|recordings|google|tasks|contacts)/.test(src), 'src/ names no module and not the probe');
	const root = fresh('a7'); ok(dt(root, initArgs).code === 0, 'init');
	ok(dt(root, ['install', '@probe/setup', '--from', FROM, '--input', 'label=probe']).code === 0, 'installed and driven');
	ok(/probe\s+configured/.test(dt(root, ['status']).stdout), 'in status');
});

scenario('A8', 'a package without setup shows no setup; one with unset declared vars names them', (ok) => {
	const root = fresh('a8'); dt(root, initArgs);
	ok(dt(root, ['install', '@fix/b', '--from', FROM]).code === 0, 'a plain module installs');
	const s = dt(root, ['status']).stdout;
	ok(!/@fix\/b\s+(ready|configured)/.test(s), 'no unit line is invented for a plain module');
	const d = dt(root, ['doctor']); ok(d.code === 0, 'doctor still renders');
});

scenario('A9', 'status and doctor are read-only and offline in every state', (ok) => {
	const root = fresh('a9'); dt(root, initArgs);
	dt(root, ['install', '@probe/setup', '--from', FROM, '--input', 'label=probe']);
	for (const env of [{}, { PROBE_EMPTY: '1' }, { PROBE_THROW: 'inspect' }]) {
		const before = treeHash(root);
		for (const a of [['status'], ['status', '--json'], ['doctor'], ['doctor', '--json']]) dt(root, a, env);
		ok(treeHash(root) === before, `unchanged under ${JSON.stringify(env)}`);
	}
	for (const f of ['setup.js', 'doctor.js']) ok(!/from 'node:(http|https|dns|net)'/.test(fs.readFileSync(path.join(ENGINE_ROOT, 'src', f), 'utf8')), `${f} imports no network module`);
});

scenario('A13', 'an existing workspace with records, git identity, a remote and staged work survives init, install, setup and update', (ok) => {
	const root = fresh('a13');
	spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: ENV });
	spawnSync('git', ['config', 'user.email', 'owner@example.invalid'], { cwd: root, env: ENV });
	spawnSync('git', ['config', 'user.name', 'Owner'], { cwd: root, env: ENV });
	fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'existing', version: '2.0.0', scripts: { build: 'make' }, dependencies: {} }, null, 2) + '\n');
	fs.mkdirSync(path.join(root, 'data', 'notes'), { recursive: true });
	fs.writeFileSync(path.join(root, 'data', 'notes', '2026-01-01--first.note.md'), '---\ntitle: First\n---\nkeep me\n');
	fs.writeFileSync(path.join(root, 'README.md'), 'mine\n');
	spawnSync('git', ['add', '-A'], { cwd: root, env: ENV }); spawnSync('git', ['commit', '-qm', 'existing work'], { cwd: root, env: ENV });
	spawnSync('git', ['remote', 'add', 'origin', 'https://example.invalid/existing.git'], { cwd: root, env: ENV });
	fs.writeFileSync(path.join(root, 'staged.txt'), 'staged\n'); spawnSync('git', ['add', 'staged.txt'], { cwd: root, env: ENV });
	fs.writeFileSync(path.join(root, 'README.md'), 'mine, edited\n');
	const config = fs.readFileSync(path.join(root, '.git', 'config'), 'utf8');
	const record = fs.readFileSync(path.join(root, 'data', 'notes', '2026-01-01--first.note.md'), 'utf8');
	for (const l of [initArgs, ['install', '@fix/a@1.0.0', '--from', FROM], ['setup', '--no-input'], ['update', '@fix/a', '--from', FROM]]) { const r = dt(root, l); ok(r.code === 0, `${l.join(' ')} exit ${r.code}: ${r.stderr}`); }
	ok(fs.readFileSync(path.join(root, 'data', 'notes', '2026-01-01--first.note.md'), 'utf8') === record, 'the record is byte-identical');
	ok(fs.readFileSync(path.join(root, '.git', 'config'), 'utf8') === config, 'git config and remote unchanged');
	ok(git(root, ['diff', '--cached', '--name-only']) === 'staged.txt', 'the staged work is still staged');
	ok(fs.readFileSync(path.join(root, 'README.md'), 'utf8') === 'mine, edited\n', 'the unstaged edit untouched');
	const subjects = git(root, ['log', '--format=%s']).split('\n');
	ok(subjects.every((s) => /^dreamteamer: |^existing work$/.test(s)), `every commit is the engine's or the owner's: ${subjects.join(' | ')}`);
	ok(!git(root, ['show', '--name-only', '--format=', 'HEAD~2..HEAD']).split('\n').includes('staged.txt'), 'no engine commit swept the staged file');
});

// ---- CR-dt-007: writing a module on the engine alone (M1–M10; the A-ids are CR-dt-006's) ----
const npmRun = (cwd, args) => spawnSync('npm', args, { cwd, env: { ...process.env, ...ENV }, encoding: 'utf8', timeout: 300_000 });
const gitIgnoreWithoutEnv = (root) => { const f = path.join(root, '.gitignore'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim() !== '.env').join('\n')); spawnSync('git', ['add', '.gitignore'], { cwd: root, env: ENV }); spawnSync('git', ['commit', '-qm', 'unignore .env'], { cwd: root, env: ENV }); };
const ALONE = path.join(ENGINE_ROOT, 'test', 'fixtures', 'alone');

scenario('M1', 'an env action: the engine writes .env, blocked at exit 0 when git would commit it, failed at exit 1 when it moved, the value never printed, the fix line whole', (ok) => {
	const SECRET = 'm1-value-never-printed';
	const root = fresh('m1'); dt(root, initArgs);
	const r = dt(root, ['install', '@probe/setup', '--from', FROM, '--input', `label=${SECRET}`, '--no-input']);
	ok(r.code === 0, `install exit ${r.code}: ${r.stderr}`);
	ok(/make-home — wrote \.env \(PROBE_HOME, PROBE_LABEL\)/.test(r.stdout), 'the engine wrote .env');
	ok(new RegExp(`^PROBE_LABEL=${SECRET}$`, 'm').test(fs.readFileSync(path.join(root, '.env'), 'utf8')), 'the value is in .env');
	const j = dt(root, ['setup', 'probe', '--input', `label=${SECRET}`, '--json']);
	ok(![r.stdout, r.stderr, j.stdout, j.stderr].some((t) => t.includes(SECRET)), 'the value is in no output, --json included');
	const s = dt(root, ['status'], { PROBE_HOME: root, PROBE_LABEL: '' }); ok(/dt setup probe --input label=<label>/.test(s.stdout), 'the fix line prints whole');
	const b = fresh('m1b'); dt(b, initArgs); gitIgnoreWithoutEnv(b);
	const rb = dt(b, ['install', '@probe/setup', '--from', FROM, '--input', 'label=x', '--no-input']);
	ok(rb.code === 0 && /make-home \(blocked\) — git would commit \.env/.test(rb.stdout), `blocked at exit 0: ${rb.code} ${rb.stdout.slice(-300)}`);
	ok(!fs.existsSync(path.join(b, '.env')), 'nothing written');
	const c = fresh('m1c'); dt(c, initArgs); dt(c, ['install', '@probe/setup', '--from', FROM, '--no-input']);
	const rc = dt(c, ['setup', 'probe', '--input', 'label=x'], { PROBE_TOUCH_ENV: '1' });
	ok(rc.code === 1 && /\.env changed after the preview — nothing was written/.test(rc.stdout), `failed at exit 1: ${rc.code}`);
});

scenario('M2', 'dt add modules --extension --package scaffolds a module the gate passes: src in the tarball, the floor, every kind, a README, one commit', (ok) => {
	const root = fresh('m2'); dt(root, initArgs);
	const r = dt(root, ['add', 'modules', '--name', 'acme', '--extension', '--package', '@acme/acme']);
	ok(r.code === 0, `add exit ${r.code}: ${r.stderr}`);
	ok(git(root, ['show', '--name-only', '--format=', 'HEAD']).split('\n').filter((f) => f !== '.env.example').sort().join(' ') === 'modules/acme/README.md modules/acme/package.json modules/acme/src/extension.js modules/acme/test/module.test.mjs', 'one commit carries the four files (and .env.example, which compile regenerates)');
	ok(git(root, ['status', '--porcelain']) === '', 'nothing left outside the commit');
	ok(npmRun(path.join(root, 'modules', 'acme'), ['test']).status === 0, 'the scaffolded test passes under npm test');
	const pkg = JSON.parse(fs.readFileSync(path.join(root, 'modules', 'acme', 'package.json'), 'utf8'));
	ok(pkg.dreamteamer.engine === `>=${VERSION}` && pkg.devDependencies?.dreamteamer === VERSION && !pkg.dependencies && !pkg.private, 'floor = this engine, engine in devDependencies, publishable');
	const dry = npmRun(path.join(root, 'modules', 'acme'), ['pack', '--dry-run', '--json']);
	const files = JSON.parse(dry.stdout)[0].files.map((f) => f.path);
	ok(files.includes('src/extension.js') && files.includes('README.md'), `the tarball: ${files.join(', ')}`);
	ok(/dt install @acme\/acme/.test(fs.readFileSync(path.join(root, 'modules', 'acme', 'README.md'), 'utf8')), 'the README carries the install line');
	const g = dt(root, ['check', 'modules/acme', '--alone']); ok(g.code === 0, `the gate: ${g.code} ${g.stderr}`);
});

scenario('M3', 'a module outside this checkout tests itself with node --test on dreamteamer/testing — on its devDependency engine, and with DT_ENGINE_DIR', (ok) => {
	const mod = fresh('m3');
	fs.writeFileSync(path.join(mod, 'package.json'), JSON.stringify({ name: '@m3/mod', version: '0.1.0', type: 'module', files: ['collections'], devDependencies: { dreamteamer: VERSION }, dreamteamer: { engine: `>=${VERSION}`, description: 'M3' } }, null, 2));
	fs.mkdirSync(path.join(mod, 'collections')); fs.writeFileSync(path.join(mod, 'collections', 'things.collection.yaml'), 'name: things\ntitle: Things\ndescription: A thing.\nfields:\n  name:\n    type: string\n');
	fs.mkdirSync(path.join(mod, 'node_modules')); fs.symlinkSync(ENGINE_ROOT, path.join(mod, 'node_modules', 'dreamteamer'), 'dir');
	fs.mkdirSync(path.join(mod, 'test'));
	fs.writeFileSync(path.join(mod, 'test', 'install.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { createWorkspace, install, run } from 'dreamteamer/testing';\ntest('installs and compiles', () => {\n  const ws = createWorkspace();\n  const r = install(ws, new URL('..', import.meta.url).pathname);\n  assert.equal(r.status, 0, r.stderr);\n  assert.match(run(ws, ['status']).stdout, /@m3\\/mod/);\n});\n");
	const a = spawnSync(process.execPath, ['--test', 'test/install.test.mjs'], { cwd: mod, env: { ...process.env, ...ENV }, encoding: 'utf8', timeout: 400_000 });
	ok(a.status === 0, `node --test: ${a.status} ${a.stdout.split('\n').filter((l) => /Error|assert|expected|actual/i.test(l)).slice(0, 8).join(' / ')}`);
	const b = spawnSync(process.execPath, ['--test', 'test/install.test.mjs'], { cwd: mod, env: { ...process.env, ...ENV, DT_ENGINE_DIR: ENGINE_ROOT }, encoding: 'utf8', timeout: 400_000 });
	ok(b.status === 0, `with DT_ENGINE_DIR: ${b.status} ${b.stdout.split('\n').filter((l) => /Error|assert|status|init/i.test(l)).slice(0, 8).join(' / ')}`);
});

scenario('M4', 'dt check modules/<id> --alone: publishable 0, needs an input 0, a missing dependency 1, a floor above 1, usage 2', (ok) => {
	const root = fresh('m4'); dt(root, initArgs);
	for (const d of fs.readdirSync(ALONE).filter((d) => d.startsWith('alone-'))) fs.cpSync(path.join(ALONE, d), path.join(root, 'modules', d), { recursive: true });
	const want = { 'alone-ok': 0, 'alone-needs-input': 0, 'alone-missing-dep': 1, 'alone-floor-above': 1 };
	for (const [id, code] of Object.entries(want)) { const r = dt(root, ['check', `modules/${id}`, '--alone']); ok(r.code === code, `${id}: exit ${r.code}, want ${code}: ${r.stderr.split('\n')[0]}`); }
	ok(/dependency @alone\/nowhere is not installed here/.test(dt(root, ['check', 'modules/alone-missing-dep', '--alone']).stderr), 'the missing dependency is named');
	ok(dt(root, ['check', 'modules/alone-ok']).code === 2 && dt(root, ['check', '--alone']).code === 2, 'the two usage shapes exit 2');
});

scenario('M5', 'an async inspect is refused at load by name; ctx.dt is the API under setup and doctor, null under install and status', (ok) => {
	const root = fresh('m5'); dt(root, initArgs);
	const m = path.join(root, 'modules', 'asyncy'); fs.mkdirSync(path.join(m, 'src'), { recursive: true });
	fs.writeFileSync(path.join(m, 'package.json'), JSON.stringify({ name: 'asyncy', private: true, type: 'module', dreamteamer: { extension: './src/extension.js' } }));
	fs.writeFileSync(path.join(m, 'src', 'extension.js'), "export default () => ({ setup: [{ id: 'asyncy', version: 1, inputs: [], inspect: async () => ({ checks: [] }), plan: () => ({ checks: [], actions: [], needs: [] }) }] });\n");
	const s = dt(root, ['status']); ok(/inspect must be synchronous/.test(s.stdout + s.stderr), `refused by name: ${(s.stdout + s.stderr).slice(0, 300)}`);
	fs.rmSync(m, { recursive: true, force: true });
	const log = path.join(root, 'ctx.log'); const env = { PROBE_CTX_LOG: log };
	dt(root, ['install', '@probe/setup', '--from', FROM, '--no-input'], env); dt(root, ['setup', 'probe', '--input', 'label=x'], env); dt(root, ['doctor'], env); dt(root, ['status'], env);
	const seen = Object.fromEntries(fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split('=')));
	ok(seen.setup === 'object' && seen.doctor === 'object' && seen.install === 'null' && seen.status === 'null', `ctx.dt per driver: ${JSON.stringify(seen)}`);
});

scenario('M6', 'dt check names dreamteamer under a module\'s dependencies; a dreamteamer peer floor\'s fix is dt update --engine', (ok) => {
	const root = fresh('m6'); dt(root, initArgs);
	const m = path.join(root, 'modules', 'deppy'); fs.mkdirSync(path.join(m, 'collections'), { recursive: true });
	fs.writeFileSync(path.join(m, 'collections', 'deps.collection.yaml'), 'name: deps\ntitle: Deps\ndescription: A dep.\nfields:\n  name:\n    type: string\n');
	fs.writeFileSync(path.join(m, 'package.json'), JSON.stringify({ name: 'deppy', private: true, dependencies: { dreamteamer: '^0.48.0' }, dreamteamer: {} }));
	dt(root, ['compile']); const c = dt(root, ['check']);
	ok(c.code === 1 && /deppy lists dreamteamer under dependencies/.test(c.stdout + c.stderr), `check names it: ${c.code}`);
	fs.writeFileSync(path.join(m, 'package.json'), JSON.stringify({ name: 'deppy', private: true, peerDependencies: { dreamteamer: '>=99.0.0' }, dreamteamer: {} }));
	const p = dt(root, ['compile']); ok(p.code !== 0 && /fix: dt update --engine/.test(p.stdout + p.stderr) && !/npm install "dreamteamer@/.test(p.stdout + p.stderr), 'the fix is dt update --engine');
});

scenario('M7', 'the writing-a-module page: every dt command in its shell blocks runs in a fresh workspace (install and publish excepted — they reach a registry)', (ok) => {
	const page = fs.readFileSync(path.join(ENGINE_ROOT, 'skills', 'using-dreamteamer', 'references', 'writing-a-module.md'), 'utf8');
	const lines = [...page.matchAll(/```bash\n([\s\S]*?)```/g)].flatMap((m) => m[1].split('\n')).map((l) => l.replace(/\s+#.*$/, '').trim()).filter((l) => /^dt /.test(l) && !/^dt (install|setup) /.test(l));
	ok(lines.length >= 2, `the page names its commands: ${lines.join(' | ')}`);
	const root = fresh('m7'); dt(root, initArgs);
	for (const l of lines) for (const part of l.split(/\s*&&\s*/)) { const args = part.replace(/^dt /, '').match(/"[^"]*"|\S+/g).map((a) => a.replace(/^"|"$/g, '')); const r = dt(root, args); ok(r.code === 0, `${part} exit ${r.code}: ${r.stderr.split('\n')[0]}`); }
});

scenario('M8', 'two modules whose units write .env, installed in one dt install: both keys land, the second plan saw the first write', (ok) => {
	const author = fresh('m8a'); dt(author, initArgs);
	const from = fresh('m8-from');
	for (const id of ['one', 'two']) { dt(author, ['add', 'modules', '--name', id, '--extension', '--package', `@m8/${id}`]); const r = npmRun(path.join(author, 'modules', id), ['pack', '--silent', '--pack-destination', from]); ok(r.status === 0, `pack ${id}`); }
	const root = fresh('m8'); dt(root, initArgs);
	const r = dt(root, ['install', '@m8/one', '@m8/two', '--from', from, '--input', 'one.token=a1', '--input', 'two.token=b2', '--no-input']);
	ok(r.code === 0, `install exit ${r.code}: ${r.stderr}${r.stdout.slice(-300)}`);
	const env = fs.readFileSync(path.join(root, '.env'), 'utf8');
	ok(/^ONE_TOKEN=a1$/m.test(env) && /^TWO_TOKEN=b2$/m.test(env), `both keys: ${env}`);
});

scenario('M9', 'the engine\'s layers and size budgets hold', (ok) => {
	ok(npmRun(ENGINE_ROOT, ['run', '--silent', 'layers']).status === 0, 'npm run layers');
	ok(npmRun(ENGINE_ROOT, ['run', '--silent', 'metrics:check']).status === 0, 'npm run metrics:check');
});

scenario('M10', 'a .env with a multi-line quoted neighbour: the env action adds its keys and leaves the neighbour byte-identical', (ok) => {
	const root = fresh('m10'); dt(root, initArgs);
	const before = 'WORK_CALENDARS="\nprimary | northwind | dana.o@northwind.example\nteam | bright | sam.d@bright.example\n"\n';
	fs.writeFileSync(path.join(root, '.env'), before);
	const r = dt(root, ['install', '@probe/setup', '--from', FROM, '--input', 'label=x', '--no-input']);
	ok(r.code === 0, `install exit ${r.code}: ${r.stderr}`);
	const after = fs.readFileSync(path.join(root, '.env'), 'utf8');
	ok(after.startsWith(before), 'the neighbour is untouched, byte for byte');
	ok(/^PROBE_LABEL=x$/m.test(after), 'the key was appended');
});

// ---- the issues' own reproductions, on the published modules (need their tarballs in --from; see README.md) ----
const hasTgz = (f) => fs.existsSync(path.join(FROM, f));
const sinceWhen = (need) => need.filter((f) => !hasTgz(f));

const A14_NEEDS = ['dreamteamer-google-workspace-0.3.0.tgz'];
if (sinceWhen(A14_NEEDS).length) console.log(`— A14 skipped: --from lacks ${sinceWhen(A14_NEEDS).join(', ')}`);
else scenario('A14', 'dt doctor refuses a world-readable OAuth client file as dt status does: a ⚠ row with the chmod fix, never ✔; owner-only is fine', (ok) => {
	const root = fresh('a14'); dt(root, initArgs);
	const store = path.join(HOME, 'a14-google-credentials');
	const i = dt(root, ['install', '@dreamteamer/google-workspace', '--from', FROM, '--input', `credentials_dir=${store}`, '--allow', 'machine', '--no-input']);
	ok([0, 3].includes(i.code), `install exit ${i.code}: ${i.stderr}${i.stdout.slice(-300)}`);
	const client = path.join(HOME, 'a14-client_secret.json');
	fs.writeFileSync(client, '{"installed":{"client_id":"x","client_secret":"y"}}');
	const env = { GOOGLE_CLIENT_SECRET_PATH: client, WORKSPACE_MCP_CREDENTIALS_DIR: store };
	fs.chmodSync(client, 0o644);
	const d = dt(root, ['doctor'], env);
	const s = dt(root, ['status'], env);
	ok(/⚠ .*readable by other users — chmod 600/.test(d.stdout), `doctor names the refusal with the fix: ${d.stdout}`);
	ok(!/✔ Credential placement/.test(d.stdout), 'doctor no longer reads Credential placement ✔ on a 644 client file');
	ok(s.code === 0, `status exit ${s.code}`);
	ok(/readable by other users — chmod 600/.test(dt(root, ['status', '--json'], env).stdout), 'status names the same refusal');
	fs.chmodSync(client, 0o600);
	const d2 = dt(root, ['doctor'], env);
	ok(!/readable by other users/.test(d2.stdout), `owner-only: no refusal row: ${d2.stdout}`);
});

const A15_NEEDS = ['dreamteamer-meetings-0.2.0.tgz', 'dreamteamer-meetings-0.3.0.tgz'];
if (sinceWhen(A15_NEEDS).length) console.log(`— A15 skipped: --from lacks ${sinceWhen(A15_NEEDS).join(', ')}`);
else scenario('A15', 'dt update of meetings 0.2.0 → 0.3.0 runs the 0.3.0 unit: exit 0, never the old "needs input: calendar", one commit, a clean tree', (ok) => {
	const root = fresh('a15'); dt(root, initArgs);
	const i = dt(root, ['install', '@dreamteamer/meetings@0.2.0', '--from', FROM, '--no-input']);
	ok([0, 3].includes(i.code), `install exit ${i.code}: ${i.stderr}${i.stdout.slice(-300)}`);
	fs.appendFileSync(path.join(root, '.env'), 'WORK_CALENDARS="team@northwind.example | northwind | dana.o@northwind.example"\n');
	const u = dt(root, ['update', '@dreamteamer/meetings', '--from', FROM]);
	ok(u.code === 0, `update exit ${u.code}: ${u.stderr}${u.stdout.slice(-400)}`);
	ok(!/needs input: calendar/.test(u.stdout), `the 0.2.0 unit did not run: ${u.stdout.slice(-400)}`);
	ok(JSON.parse(fs.readFileSync(path.join(root, 'node_modules', '@dreamteamer', 'meetings', 'package.json'), 'utf8')).version === '0.3.0', 'meetings is 0.3.0');
	ok(/^dreamteamer: update @dreamteamer\/meetings 0\.2\.0 → 0\.3\.0$/.test(git(root, ['log', '-1', '--pretty=%s'])), 'one update commit');
	ok(git(root, ['status', '--porcelain']) === '', 'nothing left uncommitted');
});

const summary = { date: new Date().toISOString(), driver: DRIVER, from: FROM, engine: VERSION, withProbe, results };
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed — evidence in ${OUT}`);
if (!process.env.DT_KEEP_FIXTURES) fs.rmSync(SANDBOX, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
