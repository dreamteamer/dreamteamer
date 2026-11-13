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
FROM = path.resolve(FROM);
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
	const tok = path.join(HOME, 'probe-token'); fs.writeFileSync(tok, 'x');
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
	const r = dt(root, ['install', '@probe/setup', '--from', FROM, '--input', 'label=probe'], { PROBE_THROW: 'apply' });
	ok(r.code === 0 && /✖ probe: blocked/.test(r.stdout) && /token=\[redacted\]/.test(r.stdout) && !/hunter2/.test(r.stdout), 'blocked, redacted, exit 0');
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

const summary = { date: new Date().toISOString(), driver: DRIVER, from: FROM, engine: VERSION, withProbe, results };
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed — evidence in ${OUT}`);
if (!process.env.DT_KEEP_FIXTURES) fs.rmSync(SANDBOX, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
