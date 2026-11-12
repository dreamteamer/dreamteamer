// Tier 2 — `dt init`, the one command from a folder to a pinned, compiled, checked, committed workspace.
// Every promise is pinned against the disk and git, never against the board's own words.
//
// ⚠ NO NETWORK, EVER. The install step's `npm` is a FAKE handed in as an argument (the `RUN.dependencies`
// precedent): it logs its cwd and argv, and puts this checkout in as `node_modules/dreamteamer`. The
// CLI-driven cases use a folder whose engine is already declared and installed, where no npm runs at all,
// and npm is FENCED (a closed registry port) so a regression fails here rather than reach a registry.
// Sandboxes live under os.tmpdir() — nobody's repo — and git may not climb above them.
import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { ENGINE_ROOT, SPAWN_TIMEOUT_MS } from '../helpers/ws.js';
import { initCommand } from '../../src/checkout.js';
import { openWorkspace, contributedViolations } from '../../src/api.js';
import { check } from '../../src/check.js';
import { buildRegistry } from '../fixtures/registry/build.mjs';

const VERSION = JSON.parse(fs.readFileSync(path.join(ENGINE_ROOT, 'package.json'), 'utf8')).version;
const BIN = path.join(ENGINE_ROOT, 'bin', 'dreamteamer.js');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dt-init-')));
process.env.GIT_CEILING_DIRECTORIES = path.dirname(SANDBOX);
after(() => { if (!process.env.DT_KEEP_FIXTURES) fs.rmSync(SANDBOX, { recursive: true, force: true }); });
let REG;
before(() => { REG = buildRegistry(); });

let n = 0;
const folder = () => { const d = path.join(SANDBOX, `ws-${++n}`); fs.mkdirSync(d); return d; };
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'dreamteamer test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'dreamteamer test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: GIT_ENV }).trim();
const isRepo = (root) => spawnSync('git', ['rev-parse', '--git-dir'], { cwd: root, stdio: 'ignore' }).status === 0;
const readPkg = (root) => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const committed = (root) => git(root, ['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean).sort();

/** A fake npm: logs `{cwd, args}`; `fail` exits 1 after leaving a partial node_modules/ behind. It installs
 *  every declared package (a stub manifest; the engine as a link to this checkout; a tarball argument by
 *  its manifest) except those named in `skip`, which it leaves out while still exiting 0. */
function fakeNpm({ fail = false, skip = [] } = {}) {
	const dir = path.join(SANDBOX, `npm-${++n}`);
	fs.mkdirSync(dir);
	const log = path.join(dir, 'calls.jsonl');
	fs.writeFileSync(path.join(dir, 'npm'), `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('11.0.0'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), args }) + '\\n');
fs.mkdirSync('node_modules/.staging', { recursive: true });
if (${fail}) process.exit(1);
const spec = args.find((a) => a.startsWith('dreamteamer@'));
if (spec) {
	const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
	pkg.dependencies = { ...pkg.dependencies, dreamteamer: spec.slice('dreamteamer@'.length) };
	fs.writeFileSync('package.json', JSON.stringify(pkg, null, '\\t') + '\\n');
}
if (!fs.existsSync('node_modules/dreamteamer')) fs.symlinkSync(${JSON.stringify(ENGINE_ROOT)}, 'node_modules/dreamteamer', 'dir');
const declared = JSON.parse(fs.readFileSync('package.json', 'utf8'));
for (const dep of Object.keys({ ...declared.dependencies, ...declared.devDependencies })) {
	if (dep === 'dreamteamer' || ${JSON.stringify(skip)}.includes(dep) || fs.existsSync('node_modules/' + dep + '/package.json')) continue;
	fs.mkdirSync('node_modules/' + dep, { recursive: true });
	fs.writeFileSync('node_modules/' + dep + '/package.json', JSON.stringify({ name: dep, version: '1.0.0' }));
}
fs.writeFileSync('package-lock.json', '{"lockfileVersion":3,"packages":{}}\\n');
`);
	fs.chmodSync(path.join(dir, 'npm'), 0o755);
	return { npm: path.join(dir, 'npm'), calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []) };
}

/** `init` in-process, its chatter captured — the only way to hand it the fake npm. Git identity via env. */
async function run(root, npm, flags = {}, argv = []) {
	const out = [];
	const saved = [console.log, console.warn, console.error];
	const env = { ...process.env };
	Object.assign(process.env, GIT_ENV);
	console.log = console.warn = console.error = (...a) => out.push(a.join(' '));
	try {
		const code = await initCommand(flags, {
			root, npm, stdio: 'ignore', log: (l) => out.push(l), open: openWorkspace, tty: false, argv,
			verify: async (ws) => check(ws, { extra: await contributedViolations(ws) }),
		});
		return { code, out: out.join('\n') };
	} finally { [console.log, console.warn, console.error] = saved; for (const k of Object.keys(GIT_ENV)) if (!(k in env)) delete process.env[k]; }
}

const NO_NETWORK = { ...GIT_ENV, npm_config_registry: 'http://127.0.0.1:9/', npm_config_cache: path.join(SANDBOX, 'npm-cache'), npm_config_fetch_retries: '0', npm_config_offline: 'true' };
function dt(cwd, ...args) {
	const r = spawnSync(process.execPath, [BIN, ...args], { cwd, env: NO_NETWORK, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS, killSignal: 'SIGKILL' });
	return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
/** A folder whose engine is already declared (exactly) and linked, so the CLI path runs no npm. */
function withEngine(root, extra = {}) {
	fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: path.basename(root), private: true, dependencies: { dreamteamer: VERSION }, ...extra }, null, '\t') + '\n');
	fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
	fs.symlinkSync(ENGINE_ROOT, path.join(root, 'node_modules', 'dreamteamer'), 'dir');
	return root;
}

/** Every file outside node_modules/ and .git/, with its content hash AND mtime. */
function snapshot(root, dir = '', out = {}) {
	for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
		const rel = path.join(dir, e.name), p = path.join(root, rel);
		if (e.isDirectory()) { if (!(dir === '' && ['node_modules', '.git'].includes(e.name))) snapshot(root, rel, out); }
		else if (e.isFile()) out[rel] = `${createHash('sha256').update(fs.readFileSync(p)).digest('hex')} ${fs.lstatSync(p).mtimeMs}`;
		else if (e.isSymbolicLink()) out[rel] = `-> ${fs.readlinkSync(p)}`;
	}
	return out;
}

describe('dt init — an empty folder to a pinned, compiled, checked, committed workspace', () => {
	test('no package.json, no git: the running engine is pinned and installed HERE, compiled, checked, a repository made, one scoped commit', async () => {
		const root = folder(), npm = fakeNpm();
		const r = await run(root, npm.npm);
		assert.equal(r.code, 0, r.out);
		assert.deepEqual(npm.calls(), [{ cwd: root, args: ['install', '--save-exact', '--no-audit', '--no-fund', `dreamteamer@${VERSION}`] }]);
		const pkg = readPkg(root);
		assert.equal(pkg.dependencies.dreamteamer, VERSION);
		assert.equal(pkg.dreamteamer.workspace_module, 'default');
		for (const f of ['.dreamteamer/manifest.yaml', 'CLAUDE.md', 'AGENTS.md', 'modules/default/collections/notes.collection.yaml']) assert.ok(fs.existsSync(path.join(root, f)), f);
		assert.ok(isRepo(root), 'a repository was created');
		assert.equal(git(root, ['rev-list', '--count', 'HEAD']), '1');
		assert.deepEqual(committed(root), ['.env.example', '.gitignore', '.vscode/extensions.json', 'modules/default/collections/notes.collection.yaml', 'modules/default/package.json', 'package-lock.json', 'package.json']);
		assert.equal(git(root, ['status', '--porcelain']), '', 'nothing left uncommitted');
		assert.ok(!fs.existsSync(path.join(root, '.env')), 'no secret file was made');
		assert.match(r.out, /✔ git: repository created/);
		assert.match(r.out, /ready: dreamteamer@/);
		// independent evidence through the real binary
		assert.equal(dt(root, 'check').code, 0);
		assert.equal(JSON.parse(dt(root, 'doctor', '--json').stdout).capabilities.find((c) => c.name === 'engine').verdict, 'READY');
	});

	test('a repeat changes nothing: no npm, no compile, no commit, not one file rewritten', async () => {
		const root = folder(), npm = fakeNpm();
		assert.equal((await run(root, npm.npm)).code, 0);
		const before = snapshot(root), head = git(root, ['rev-parse', 'HEAD']);
		const r = await run(root, npm.npm);
		assert.equal(r.code, 0, r.out);
		assert.equal(npm.calls().length, 1, 'npm ran again');
		assert.match(r.out, new RegExp(`✔ dependencies: dreamteamer@${VERSION.replace(/\./g, '\\.')} and every declared package installed\\n✔ compile: fresh`));
		assert.match(r.out, /✔ git: nothing new to commit/);
		assert.equal(git(root, ['rev-parse', 'HEAD']), head);
		assert.deepEqual(snapshot(root), before);
	});

	test('--no-git: written, not committed, and the last lines say so; --git <url> adds origin and never pushes', async () => {
		const a = folder(), npm = fakeNpm();
		const r = await run(a, npm.npm, { 'no-git': true });
		assert.equal(r.code, 0, r.out);
		assert.ok(!isRepo(a));
		assert.match(r.out, /— git: skipped \(--no-git\)/);
		const b = folder(), npm2 = fakeNpm();
		const s = await run(b, npm2.npm, { git: 'https://example.invalid/b.git' });
		assert.equal(s.code, 0, s.out);
		assert.equal(git(b, ['remote', 'get-url', 'origin']), 'https://example.invalid/b.git');
		assert.equal(git(b, ['rev-list', '--count', 'HEAD']), '1');
		assert.match(s.out, /origin → https:\/\/example\.invalid\/b\.git \(never pushed\)/);
	});

	test('--no-compile: pinned and installed, no runtime, still committed', async () => {
		const root = folder(), npm = fakeNpm();
		const r = await run(root, npm.npm, { 'no-compile': true });
		assert.equal(r.code, 0, r.out);
		assert.ok(!fs.existsSync(path.join(root, '.dreamteamer')));
		assert.match(r.out, /— compile: skipped \(--no-compile\)/);
		assert.equal(git(root, ['rev-list', '--count', 'HEAD']), '1');
	});

	test('an install interrupted part-way leaves the skeleton and no runtime; the same command again completes it', async () => {
		const root = folder(), broken = fakeNpm({ fail: true });
		const r = await run(root, broken.npm);
		assert.equal(r.code, 1);
		assert.match(r.out, /✖ npm exited 1\n {2}the steps after this one did not run — fix it, then run the same command again/);
		assert.ok(!fs.existsSync(path.join(root, '.dreamteamer')), 'nothing compiled past a failed install');
		const npm = fakeNpm();
		const again = await run(root, npm.npm);
		assert.equal(again.code, 0, again.out);
		assert.equal(npm.calls().length, 1);
		assert.ok(fs.existsSync(path.join(root, '.dreamteamer/manifest.yaml')));
	});

	test('a compile that fails resumes without reinstalling', async () => {
		const root = folder(), npm = fakeNpm();
		fs.mkdirSync(path.join(root, 'modules', 'default', 'bogus'), { recursive: true });
		const r = await run(root, npm.npm);
		assert.equal(r.code, 1);
		assert.match(r.out, /✖ compile: .*bogus/);
		fs.rmSync(path.join(root, 'modules', 'default', 'bogus'), { recursive: true });
		const again = await run(root, npm.npm);
		assert.equal(again.code, 0, again.out);
		assert.equal(npm.calls().length, 1, 'the installed engine was not installed twice');
	});

	test('a cloned preset that declares the engine gets its own lockfile restored — nothing re-pinned', async () => {
		const root = folder(), npm = fakeNpm();
		fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'preset', private: true, dependencies: { dreamteamer: `^${VERSION}` } }, null, '\t') + '\n');
		const r = await run(root, npm.npm);
		assert.equal(r.code, 0, r.out);
		assert.deepEqual(npm.calls().map((c) => c.args), [['install', '--no-audit', '--no-fund']]);
		assert.equal(readPkg(root).dependencies.dreamteamer, `^${VERSION}`);
	});

	test('a preset with modules, offline (--from): the missing packages come from the folder, package.json is byte-identical, the safe setup runs', async () => {
		const root = folder();
		// the engine present and declared; two modules declared by name and absent
		withEngine(root, { dependencies: { dreamteamer: VERSION, '@fix/b': '1.0.0', '@probe/setup': '1.0.0' } });
		const text = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
		const r = dt(root, 'init', '--from', REG, '--input', 'label=preset', '--no-input');
		assert.equal(r.code, 0, r.stdout + r.stderr);
		assert.match(r.stdout, /npm install --no-save --no-audit --no-fund .*fix-b-1\.0\.0\.tgz .*probe-setup-1\.0\.0\.tgz/);
		const { dreamteamer: block, ...rest } = readPkg(root);
		assert.deepEqual(rest, JSON.parse(text), 'init added its block and nothing else — no --no-save package was written into dependencies');
		assert.equal(block.workspace_module, 'default');
		assert.ok(fs.existsSync(path.join(root, 'node_modules', '@fix', 'b', 'package.json')));
		assert.ok(fs.existsSync(path.join(root, '.dreamteamer', 'collections', 'fixbs.collection.yaml')), 'compiled with the modules');
		assert.match(r.stdout, /✔ make-home — wrote \.env/);
		assert.match(r.stdout, /probe\s+configured/);
		assert.ok(isRepo(root) && git(root, ['rev-list', '--count', 'HEAD']) === '1');
		// a folder lacking a declared package is refused before any write
		const w = withEngine(folder(), { dependencies: { dreamteamer: VERSION, '@fix/nope': '1.0.0' } });
		const bad = dt(w, 'init', '--from', REG);
		assert.equal(bad.code, 1);
		assert.match(bad.stdout, /--from .* no @fix\/nope in it — nothing was installed/);
		assert.ok(!fs.existsSync(path.join(w, '.dreamteamer')));
	});

	test('the engine installed but a selected package missing: npm restores it before anything compiles; npm exiting 0 with it still absent is a failure', async () => {
		const mk = () => withEngine(folder(), { dependencies: { dreamteamer: VERSION, '@example/missing-capability': '1.0.0' } });
		const a = mk(), npm = fakeNpm();
		const r = await run(a, npm.npm);
		assert.equal(r.code, 0, r.out);
		assert.match(r.out, /▶ dependencies: npm install --no-audit --no-fund — missing @example\/missing-capability/);
		assert.ok(fs.existsSync(path.join(a, 'node_modules', '@example', 'missing-capability', 'package.json')));
		const b = mk(), lazy = fakeNpm({ skip: ['@example/missing-capability'] });
		const s = await run(b, lazy.npm);
		assert.equal(s.code, 1);
		assert.match(s.out, /✖ npm finished, but @example\/missing-capability is still not installed/);
		assert.ok(!fs.existsSync(path.join(b, '.dreamteamer')));
	});
});

describe('dt init never writes outside the folder', () => {
	const outside = (name, text) => { const p = path.join(SANDBOX, `outside-${++n}-${name}`); if (text !== undefined) fs.writeFileSync(p, text); return p; };
	const refused = (root, args, what) => {
		const r = dt(root, 'init', ...args);
		assert.equal(r.code, 1, r.stdout);
		assert.match(r.stderr, new RegExp(`✖ ${what.replace(/\./g, '\\.')}[^\\n]* resolves? outside this workspace — init writes there, so nothing was written`));
		assert.ok(!fs.existsSync(path.join(root, 'package.json')), 'a write happened before the refusal');
	};

	test('a file linked out (.gitignore), a parent linked out (modules/), a dangling link (CLAUDE.md) and a configured path climbing out (--data_path ../x)', () => {
		const a = folder(); fs.symlinkSync(outside('ignore', 'x'), path.join(a, '.gitignore')); refused(a, [], '.gitignore');
		const b = folder(); const dir = outside('modules'); fs.mkdirSync(dir); fs.symlinkSync(dir, path.join(b, 'modules'), 'dir'); refused(b, [], 'modules/');
		const c = folder(); fs.symlinkSync(outside('gone'), path.join(c, 'CLAUDE.md')); refused(c, [], 'CLAUDE.md');
		const d = folder(); refused(d, ['--data_path', '../x'], '../x');
	});

	test('a folder alias inside an output tree is refused even when it points inside', () => {
		const root = folder();
		fs.mkdirSync(path.join(root, 'real-skills'));
		fs.mkdirSync(path.join(root, '.claude'));
		fs.symlinkSync(path.join(root, 'real-skills'), path.join(root, '.claude', 'skills'), 'dir');
		const r = dt(root, 'init');
		assert.equal(r.code, 1, r.stdout);
		assert.match(r.stderr, /\.claude\/skills: a folder link inside compile's output/);
		assert.ok(!fs.existsSync(path.join(root, 'package.json')));
	});

	test('a dangling link through a link, and a loop', () => {
		const a = folder();
		fs.symlinkSync(outside('bridge-target'), path.join(a, 'bridge'));
		fs.symlinkSync('bridge/new.txt', path.join(a, '.gitignore'));
		refused(a, [], '.gitignore');
		const b = folder();
		fs.symlinkSync('loop2', path.join(b, 'loop1')); fs.symlinkSync('loop1', path.join(b, 'loop2'));
		fs.symlinkSync('loop1', path.join(b, '.gitignore'));
		const r = dt(b, 'init');
		assert.equal(r.code, 1);
		assert.match(r.stderr, /\.gitignore/);
	});

	test('a link that stays INSIDE the folder is fine', () => {
		const root = withEngine(folder());
		fs.mkdirSync(path.join(root, 'elsewhere'));
		fs.writeFileSync(path.join(root, 'elsewhere', 'ignore'), 'node_modules/\n');
		fs.symlinkSync('elsewhere/ignore', path.join(root, '.gitignore'));
		const r = dt(root, 'init');
		assert.equal(r.code, 0, r.stdout + r.stderr);
		assert.ok(fs.lstatSync(path.join(root, '.gitignore')).isSymbolicLink(), 'the link was kept');
	});
});

describe('dt init in an EXISTING, dirty repo', () => {
	test('one commit scoped to its own files; staged, unstaged and untracked work, origin and git config are exactly as they were', () => {
		const root = folder();
		git(root, ['init', '-q', '-b', 'main']);
		git(root, ['config', 'user.email', 'someone@example.invalid']);
		git(root, ['config', 'user.name', 'Someone']);
		fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'acme-notes', version: '1.0.0', scripts: { build: 'make' }, custom: { keep: true }, dependencies: { dreamteamer: VERSION } }, null, 2) + '\n');
		fs.mkdirSync(path.join(root, 'node_modules'));
		fs.symlinkSync(ENGINE_ROOT, path.join(root, 'node_modules', 'dreamteamer'), 'dir');
		fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
		fs.writeFileSync(path.join(root, 'notes.txt'), 'v1\n');
		git(root, ['add', '-A']); git(root, ['commit', '-qm', 'existing work']);
		git(root, ['remote', 'add', 'origin', 'https://example.invalid/acme.git']);
		fs.writeFileSync(path.join(root, 'notes.txt'), 'v2, not staged\n');
		fs.writeFileSync(path.join(root, 'staged.txt'), 'staged\n'); git(root, ['add', 'staged.txt']);
		fs.writeFileSync(path.join(root, 'untracked.txt'), 'mine\n');
		const head = git(root, ['rev-parse', 'HEAD']), config = fs.readFileSync(path.join(root, '.git', 'config'), 'utf8');

		const r = dt(root, 'init');
		assert.equal(r.code, 0, r.stdout + r.stderr);
		assert.match(r.stdout, new RegExp(`✔ dependencies: dreamteamer@${VERSION.replace(/\./g, '\\.')} and every declared package installed`));
		assert.notEqual(git(root, ['rev-parse', 'HEAD']), head, 'init committed its own files');
		assert.equal(git(root, ['rev-list', '--count', 'HEAD']), '2');
		assert.equal(git(root, ['log', '-1', '--format=%s']), 'dreamteamer: init workspace acme-notes');
		assert.deepEqual(committed(root), ['.env.example', '.gitignore', '.vscode/extensions.json', 'modules/default/collections/notes.collection.yaml', 'modules/default/package.json', 'package.json']);
		assert.equal(git(root, ['remote', 'get-url', 'origin']), 'https://example.invalid/acme.git');
		assert.equal(fs.readFileSync(path.join(root, '.git', 'config'), 'utf8'), config);
		assert.equal(git(root, ['diff', '--cached', '--name-only']), 'staged.txt', 'the operator\'s staged work is still staged, and not in init\'s commit');
		assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'v2, not staged\n');
		assert.equal(fs.readFileSync(path.join(root, 'untracked.txt'), 'utf8'), 'mine\n');
		const pkg = readPkg(root);
		assert.deepEqual([pkg.custom, pkg.scripts, pkg.dependencies.dreamteamer], [{ keep: true }, { build: 'make' }, VERSION]);
		assert.ok(fs.readFileSync(path.join(root, '.gitignore'), 'utf8').startsWith('node_modules/\n'), 'the existing .gitignore is appended to, never replaced');
		assert.ok(fs.existsSync(path.join(root, '.dreamteamer/manifest.yaml')));
	});
});

describe('dt init refuses before it writes anything', () => {
	const untouched = (root) => fs.readdirSync(root).sort();
	test('--ready is no longer a flag', () => {
		const root = folder();
		const r = dt(root, 'init', '--ready', VERSION);
		assert.equal(r.code, 1);
		assert.match(r.stderr, /unknown flag "--ready"/);
		assert.deepEqual(untouched(root), []);
	});
	const refusedAsIs = (files, why) => {
		const root = folder();
		for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); }
		const r = dt(root, 'init');
		assert.equal(r.code, 1, r.stdout);
		assert.match(r.stderr, why);
		assert.match(r.stderr, /init never changes an existing engine|keep one declaration/);
		for (const [rel, text] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(root, rel), 'utf8'), text, rel);
		assert.deepEqual(untouched(root), [...new Set(Object.keys(files).map((f) => f.split('/')[0]))].sort());
	};
	const pkgWith = (deps) => JSON.stringify({ name: 'old', ...deps }) + '\n';
	test('an engine of another version — declared, locked or installed — is the workspace\'s choice, never upgraded', () => {
		refusedAsIs({ 'package.json': pkgWith({ dependencies: { dreamteamer: '0.0.1' } }) }, /package\.json declares dreamteamer "0\.0\.1", which .* is not/);
		refusedAsIs({ 'package.json': pkgWith({ dependencies: { dreamteamer: '^0.1.0' } }) }, /package\.json declares dreamteamer "\^0\.1\.0"/);
		refusedAsIs({ 'node_modules/dreamteamer/package.json': '{ "name": "dreamteamer", "version": "0.0.2" }' }, /node_modules holds dreamteamer 0\.0\.2/);
		refusedAsIs({ 'package.json': pkgWith({ dependencies: { dreamteamer: VERSION } }), 'package-lock.json': '{ "packages": { "node_modules/dreamteamer": { "version": "0.0.3" } } }\n' }, /package-lock\.json locks dreamteamer 0\.0\.3/);
		refusedAsIs({ 'package.json': pkgWith({ dependencies: { dreamteamer: VERSION }, devDependencies: { dreamteamer: '0.0.4' } }) }, /declares dreamteamer twice, differently/);
	});
	test('a declaration that disagrees with the installed engine is refused, not adopted', () => {
		const root = folder();
		const text = pkgWith({ dependencies: { dreamteamer: '0.45.0' } });
		fs.writeFileSync(path.join(root, 'package.json'), text);
		fs.mkdirSync(path.join(root, 'node_modules'));
		fs.symlinkSync(ENGINE_ROOT, path.join(root, 'node_modules', 'dreamteamer'), 'dir');
		const r = dt(root, 'init');
		assert.equal(r.code, 1, r.stdout);
		assert.match(r.stderr, /package\.json declares dreamteamer "0\.45\.0"/);
		assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), text);
	});
	test('a re-run leaves a package.json that already holds the block byte-for-byte, whatever its formatting', () => {
		const root = withEngine(folder());
		assert.equal(dt(root, 'init').code, 0);
		const twoSpace = JSON.stringify(readPkg(root), null, 2) + '\n';
		fs.writeFileSync(path.join(root, 'package.json'), twoSpace);
		assert.equal(dt(root, 'init').code, 0);
		assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), twoSpace);
	});
});
