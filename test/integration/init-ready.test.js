// Tier 2 — `dt init --ready <version>`, the one-command bootstrap, and the legacy `dt init` it must not
// change. Every promise is pinned against the disk and git, never against the board's own words.
//
// ⚠ NO NETWORK, EVER. The install step's `npm` is a FAKE handed in as an argument (the `RUN.dependencies`
// precedent): it logs its cwd and argv, and puts this checkout in as `node_modules/dreamteamer`. The
// CLI-driven cases use a workspace whose engine is already installed, where no npm runs at all.
// Sandboxes live under os.tmpdir() — nobody's repo — and git may not climb above them.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { ENGINE_ROOT, SPAWN_TIMEOUT_MS } from '../helpers/ws.js';
import { bootstrap } from '../../src/checkout.js';
import { openWorkspace, contributedViolations } from '../../src/api.js';
import { check } from '../../src/check.js';

const VERSION = JSON.parse(fs.readFileSync(path.join(ENGINE_ROOT, 'package.json'), 'utf8')).version;
const BIN = path.join(ENGINE_ROOT, 'bin', 'dreamteamer.js');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dt-ready-')));
process.env.GIT_CEILING_DIRECTORIES = path.dirname(SANDBOX); // a stray repo above the temp dir is never found
after(() => { if (!process.env.DT_KEEP_FIXTURES) fs.rmSync(SANDBOX, { recursive: true, force: true }); });

let n = 0;
const folder = () => { const d = path.join(SANDBOX, `ws-${++n}`); fs.mkdirSync(d); return d; };
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const isRepo = (root) => spawnSync('git', ['rev-parse', '--git-dir'], { cwd: root, stdio: 'ignore' }).status === 0;
const readPkg = (root) => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

/** A fake npm: logs `{cwd, args}` to `<bin>/calls.jsonl`; `fail` exits 1 after leaving a partial
 *  `node_modules/` behind, the way an interrupted download does. It installs every declared package
 *  (a stub manifest; the engine as a link to this checkout) except those named in `skip`, which it
 *  leaves out while still exiting 0 — npm's own "exit 0, not installed" shape. */
function fakeNpm({ fail = false, skip = [] } = {}) {
	const dir = path.join(SANDBOX, `npm-${++n}`);
	fs.mkdirSync(dir);
	const log = path.join(dir, 'calls.jsonl');
	fs.writeFileSync(path.join(dir, 'npm'), `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
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

/** `init --ready` in-process, its chatter captured — the only way to hand it the fake npm. */
async function ready(root, npm, flags = {}) {
	const out = [];
	const saved = [console.log, console.warn, console.error];
	console.log = console.warn = console.error = (...a) => out.push(a.join(' '));
	try {
		const code = await bootstrap({ ready: VERSION, ...flags }, {
			root, npm, stdio: 'ignore', log: (l) => out.push(l), open: openWorkspace,
			verify: async (ws) => check(ws, { extra: await contributedViolations(ws) }),
		});
		return { code, out: out.join('\n') };
	} finally { [console.log, console.warn, console.error] = saved; }
}

/** The real binary, in `cwd` — with npm FENCED. These cases expect no npm to run; if a regression lets
 *  one through, it must fail here rather than reach a registry or the user's cache (measured: with the
 *  guards switched off, an unfenced run downloaded the published engine). A closed local port for the
 *  registry, and a cache inside the sandbox. */
const NO_NETWORK = { ...process.env, npm_config_registry: 'http://127.0.0.1:9/', npm_config_cache: path.join(SANDBOX, 'npm-cache'), npm_config_fetch_retries: '0', npm_config_offline: 'true' };
function dt(cwd, ...args) {
	const r = spawnSync(process.execPath, [BIN, ...args], { cwd, env: NO_NETWORK, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS, killSignal: 'SIGKILL' });
	return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Every file outside node_modules/ and .git/, with its content hash AND mtime — equal snapshots mean
 *  nothing was rewritten, not merely rewritten with the same bytes. node_modules/ and .git/ are pruned
 *  BEFORE descent and no link is followed: the engine is linked in, and a walk through it is unbounded. */
function snapshot(root, dir = '', out = {}) {
	for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
		const rel = path.join(dir, e.name), p = path.join(root, rel);
		if (e.isDirectory()) { if (!(dir === '' && ['node_modules', '.git'].includes(e.name))) snapshot(root, rel, out); }
		else if (e.isFile()) out[rel] = `${createHash('sha256').update(fs.readFileSync(p)).digest('hex')} ${fs.lstatSync(p).mtimeMs}`;
		else if (e.isSymbolicLink()) out[rel] = `-> ${fs.readlinkSync(p)}`;
	}
	return out;
}

describe('dt init --ready — an empty folder to a compiled, checked workspace in one command', () => {
	test('no package.json, no git: the pinned engine is installed HERE, compiled, checked — and no repository, remote or .env is made', async () => {
		const root = folder(), npm = fakeNpm();
		const r = await ready(root, npm.npm);
		assert.equal(r.code, 0, r.out);
		// npm ran ONCE, in this folder (a package.json existed first, so npm cannot climb to a parent's), with the exact pin
		assert.deepEqual(npm.calls(), [{ cwd: root, args: ['install', '--save-exact', '--no-audit', '--no-fund', `dreamteamer@${VERSION}`] }]);
		const pkg = readPkg(root);
		assert.equal(pkg.dependencies.dreamteamer, VERSION);
		assert.equal(pkg.dreamteamer.workspace_module, 'default');
		for (const f of ['.dreamteamer/manifest.yaml', 'CLAUDE.md', 'AGENTS.md', 'modules/default/collections/notes.collection.yaml']) assert.ok(fs.existsSync(path.join(root, f)), f);
		// the handoff it prints names a file that is there to read
		const handoff = r.out.match(/read (\.dreamteamer\/\S+setup\.md)/)?.[1];
		assert.ok(handoff && fs.existsSync(path.join(root, handoff)), r.out);
		assert.ok(!fs.existsSync(path.join(root, '.git')) && !isRepo(root), 'no repository was created');
		assert.ok(!fs.existsSync(path.join(root, '.env')), 'no secret file was made');
		assert.match(r.out, /— git: not a repository, and none was made/);
		// independent evidence through the real binary, not the bootstrap's own word
		assert.equal(dt(root, 'check').code, 0);
		const caps = JSON.parse(dt(root, 'doctor', '--json').stdout).capabilities;
		assert.equal(caps.find((c) => c.name === 'engine').verdict, 'READY');
	});

	test('a repeat changes nothing: no npm, no compile, not one file rewritten', async () => {
		const root = folder(), npm = fakeNpm();
		assert.equal((await ready(root, npm.npm)).code, 0);
		const before = snapshot(root);
		const r = await ready(root, npm.npm);
		assert.equal(r.code, 0, r.out);
		assert.equal(npm.calls().length, 1, 'npm ran again');
		assert.match(r.out, new RegExp(`✔ dependencies: dreamteamer@${VERSION.replace(/\./g, '\\.')} and every declared package installed\\n✔ compile: fresh`));
		assert.deepEqual(snapshot(root), before);
	});

	test('an install interrupted part-way leaves the skeleton and no runtime; the same command again completes it', async () => {
		const root = folder(), broken = fakeNpm({ fail: true });
		const r = await ready(root, broken.npm);
		assert.equal(r.code, 1);
		assert.match(r.out, /✖ npm exited 1\n {2}the steps after this one did not run — fix it, then run the same command again/);
		assert.ok(!fs.existsSync(path.join(root, '.dreamteamer')), 'nothing compiled past a failed install');
		assert.equal(readPkg(root).dependencies, undefined);
		const npm = fakeNpm();
		const again = await ready(root, npm.npm);
		assert.equal(again.code, 0, again.out);
		assert.equal(npm.calls().length, 1);
		assert.ok(fs.existsSync(path.join(root, '.dreamteamer/manifest.yaml')));
	});

	test('a compile that fails resumes without reinstalling', async () => {
		const root = folder(), npm = fakeNpm();
		fs.mkdirSync(path.join(root, 'modules', 'default', 'bogus'), { recursive: true }); // an unknown folder: a compile error
		const r = await ready(root, npm.npm);
		assert.equal(r.code, 1);
		assert.match(r.out, /✖ compile: .*bogus/);
		fs.rmSync(path.join(root, 'modules', 'default', 'bogus'), { recursive: true });
		const again = await ready(root, npm.npm);
		assert.equal(again.code, 0, again.out);
		assert.equal(npm.calls().length, 1, 'the installed engine was not installed twice');
		assert.match(again.out, /▶ compile/);
	});

	test('a cloned preset that declares the engine gets its own lockfile restored — no package named, nothing re-pinned', async () => {
		const root = folder(), npm = fakeNpm();
		fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'preset', private: true, dependencies: { dreamteamer: `^${VERSION}` } }, null, '\t') + '\n');
		const r = await ready(root, npm.npm);
		assert.equal(r.code, 0, r.out);
		assert.deepEqual(npm.calls().map((c) => c.args), [['install', '--no-audit', '--no-fund']]);
		assert.equal(readPkg(root).dependencies.dreamteamer, `^${VERSION}`);
	});

	// review finding: the engine installed and a SELECTED module missing (an interrupted preset install)
	// skipped npm, compiled without the module, and returned 0
	const withEngineOnly = () => {
		const root = folder();
		fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'preset', private: true, dependencies: { dreamteamer: VERSION, '@example/missing-capability': '1.0.0' } }, null, '\t') + '\n');
		fs.mkdirSync(path.join(root, 'node_modules'));
		fs.symlinkSync(ENGINE_ROOT, path.join(root, 'node_modules', 'dreamteamer'), 'dir');
		return root;
	};

	test('the engine installed but a selected package missing: npm restores it before anything compiles', async () => {
		const root = withEngineOnly(), npm = fakeNpm();
		const r = await ready(root, npm.npm);
		assert.equal(r.code, 0, r.out);
		assert.match(r.out, /▶ dependencies: npm install --no-audit --no-fund — missing @example\/missing-capability/);
		assert.deepEqual(npm.calls().map((c) => c.args), [['install', '--no-audit', '--no-fund']]);
		assert.ok(fs.existsSync(path.join(root, 'node_modules', '@example', 'missing-capability', 'package.json')));
	});

	test('npm exiting 0 with a selected package still absent is a failure, and nothing compiles', async () => {
		const root = withEngineOnly(), npm = fakeNpm({ skip: ['@example/missing-capability'] });
		const r = await ready(root, npm.npm);
		assert.equal(r.code, 1);
		assert.match(r.out, /✖ npm finished, but @example\/missing-capability is still not installed/);
		assert.ok(!fs.existsSync(path.join(root, '.dreamteamer')));
	});
});

describe('dt init --ready never writes outside the folder', () => {
	// review finding: a `.gitignore` linked to a file outside was appended to, and the run returned 0
	const outside = (name, text) => { const p = path.join(SANDBOX, `outside-${++n}-${name}`); if (text !== undefined) fs.writeFileSync(p, text); return p; };
	const refused = (root, args, what) => {
		const r = dt(root, 'init', '--ready', VERSION, ...args);
		assert.equal(r.code, 1, r.stdout);
		assert.match(r.stderr, new RegExp(`✖ ${what.replace(/\./g, '\\.')}[^\\n]* resolves? outside this workspace — init --ready writes there, so nothing was written`));
		assert.ok(!fs.existsSync(path.join(root, 'package.json')), 'a write happened before the refusal');
	};

	test('a file linked out (.gitignore), a parent linked out (modules/), a dangling link (CLAUDE.md) and a configured path climbing out (--data_path ../x)', () => {
		const file = outside('gitignore', 'UNCHANGED\n');
		const a = folder(); fs.symlinkSync(file, path.join(a, '.gitignore'));
		refused(a, [], '.gitignore');
		assert.equal(fs.readFileSync(file, 'utf8'), 'UNCHANGED\n');

		const dir = outside('modules'); fs.mkdirSync(dir);
		const b = folder(); fs.symlinkSync(dir, path.join(b, 'modules'), 'dir');
		refused(b, [], 'modules/default/');
		assert.deepEqual(fs.readdirSync(dir), []);

		const ghost = outside('CLAUDE.md');
		const c = folder(); fs.symlinkSync(ghost, path.join(c, 'CLAUDE.md'));
		refused(c, [], 'CLAUDE.md');
		assert.ok(!fs.existsSync(ghost), 'the dangling link\'s target was created');

		const d = folder();
		refused(d, ['--data_path', '../escape'], '../escape');
		assert.ok(!fs.existsSync(path.join(path.dirname(d), 'escape')));
	});

	// The second review's bypasses, each as it was reproduced, plus the neighbours of each: an existing
	// workspace (engine declared and installed, so no npm runs) and a target outside that must not change.
	const existing = (block) => {
		const root = folder();
		fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, dependencies: { dreamteamer: VERSION }, ...(block ? { dreamteamer: block } : {}) }) + '\n');
		fs.mkdirSync(path.join(root, 'node_modules'));
		fs.symlinkSync(ENGINE_ROOT, path.join(root, 'node_modules', 'dreamteamer'), 'dir');
		return root;
	};
	const refusedHere = (root, args, what) => {
		const pkg = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
		const r = dt(root, 'init', '--ready', VERSION, ...args);
		assert.equal(r.code, 1, r.stdout);
		assert.match(r.stderr, new RegExp(`${what.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]* resolves? outside this workspace`));
		assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), pkg, 'package.json was written before the refusal');
		assert.ok(!fs.existsSync(path.join(root, '.dreamteamer', 'skills')), 'compile ran');
	};

	const refusedAliased = (root, what) => {
		const pkg = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
		const r = dt(root, 'init', '--ready', VERSION);
		assert.equal(r.code, 1, r.stdout);
		assert.match(r.stderr, new RegExp(`✖ ${what.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: a folder link inside compile's output — compile writes through it, so nothing was written`));
		assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), pkg, 'package.json was written before the refusal');
	};

	// third review: a folder link that stays INSIDE the workspace hid a file link below it that did not
	test('a folder alias inside an output tree is refused even when it points inside — it hid an escaping child — and so is an aliased output root', () => {
		const marker = outside('skill-marker', 'UNCHANGED\n');
		const root = existing();
		fs.mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true });
		fs.mkdirSync(path.join(root, 'local-skill'));
		fs.symlinkSync(path.join('..', '..', 'local-skill'), path.join(root, '.claude', 'skills', 'using-dreamteamer'), 'dir');
		fs.symlinkSync(marker, path.join(root, 'local-skill', 'SKILL.md'));
		refusedAliased(root, '.claude/skills/using-dreamteamer');
		assert.equal(fs.readFileSync(marker, 'utf8'), 'UNCHANGED\n');
		assert.ok(!fs.existsSync(path.join(root, '.dreamteamer')), 'compile ran');

		const rt = existing();
		fs.mkdirSync(path.join(rt, 'runtime-elsewhere'));
		fs.symlinkSync('runtime-elsewhere', path.join(rt, '.dreamteamer'), 'dir');
		refusedAliased(rt, '.dreamteamer');
		assert.deepEqual(fs.readdirSync(path.join(rt, 'runtime-elsewhere')), []);
	});

	test('a FILE link inside an output tree that stays inside the workspace is still allowed, and left as it was', () => {
		const root = existing();
		fs.mkdirSync(path.join(root, 'docs'));
		fs.writeFileSync(path.join(root, 'docs', 'note.md'), 'mine\n');
		fs.mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true });
		fs.symlinkSync(path.join('..', '..', 'docs', 'note.md'), path.join(root, '.claude', 'skills', 'note.md'));
		const r = dt(root, 'init', '--ready', VERSION);
		assert.equal(r.code, 0, r.stdout + r.stderr);
		assert.equal(fs.readlinkSync(path.join(root, '.claude', 'skills', 'note.md')), path.join('..', '..', 'docs', 'note.md'));
		assert.equal(fs.readFileSync(path.join(root, 'docs', 'note.md'), 'utf8'), 'mine\n');
	});

	test('the STORED workspace module wins over a safe flag, exactly as init merges it — and a null one puts the skeleton at the root', () => {
		const away = outside('module'); fs.mkdirSync(away);
		const root = existing({ workspace_module: `../../${path.basename(away)}` });
		refusedHere(root, ['--workspace_module', 'default'], `modules/../../${path.basename(away)}/collections`);
		assert.deepEqual(fs.readdirSync(away), []);

		const flat = outside('flat'); fs.mkdirSync(flat);
		const legacy = existing({ workspace_module: null });
		fs.symlinkSync(flat, path.join(legacy, 'collections'), 'dir');
		refusedHere(legacy, [], './collections');
		assert.deepEqual(fs.readdirSync(flat), []);

		const odd = existing({ workspace_module: 7 });
		const r = dt(odd, 'init', '--ready', VERSION);
		assert.equal(r.code, 1);
		assert.match(r.stderr, /dreamteamer\.workspace_module must be a path \(got 7\) — nothing was written/);
	});

	test('a link NESTED in an output tree: .claude/skills linked out, .dreamteamer/manifest.yaml linked to a file outside', () => {
		const away = outside('skills'); fs.mkdirSync(away);
		const a = existing();
		fs.mkdirSync(path.join(a, '.claude'));
		fs.symlinkSync(away, path.join(a, '.claude', 'skills'), 'dir');
		refusedAliased(a, '.claude/skills');
		assert.deepEqual(fs.readdirSync(away), []);

		const marker = outside('marker', '{}\n');
		const b = existing();
		fs.mkdirSync(path.join(b, '.dreamteamer'));
		fs.symlinkSync(marker, path.join(b, '.dreamteamer', 'manifest.yaml'));
		refusedHere(b, [], '.dreamteamer/manifest.yaml');
		assert.equal(fs.readFileSync(marker, 'utf8'), '{}\n');
	});

	test('a dangling link through a link: .gitignore → bridge/new.txt, bridge → outside; and a loop', () => {
		const away = outside('bridge'); fs.mkdirSync(away);
		const root = existing();
		fs.symlinkSync(away, path.join(root, 'bridge'), 'dir');
		fs.symlinkSync(path.join('bridge', 'new.txt'), path.join(root, '.gitignore'));
		refusedHere(root, [], '.gitignore');
		assert.ok(!fs.existsSync(path.join(away, 'new.txt')), 'created outside through both links');

		const loop = existing();
		fs.symlinkSync('b', path.join(loop, 'a')); fs.symlinkSync('a', path.join(loop, 'b'));
		fs.symlinkSync('a', path.join(loop, '.gitignore'));
		refusedHere(loop, [], '.gitignore');
	});

	test('managed-block files: a top-level one a contributed harness writes (NOTEBOOKLM.md), and a nested one the last compile recorded', () => {
		const file = outside('notebooklm', 'UNCHANGED\n');
		const a = existing();
		fs.symlinkSync(file, path.join(a, 'NOTEBOOKLM.md'));
		refusedHere(a, [], 'NOTEBOOKLM.md');
		assert.equal(fs.readFileSync(file, 'utf8'), 'UNCHANGED\n');

		const away = outside('github'); fs.mkdirSync(away);
		const b = existing();
		fs.mkdirSync(path.join(b, '.dreamteamer'));
		fs.writeFileSync(path.join(b, '.dreamteamer', 'manifest.yaml'), "adapter-blocks:\n  - .github/agent.md\n");
		fs.symlinkSync(away, path.join(b, '.github'), 'dir');
		refusedHere(b, [], '.github/agent.md');
		assert.deepEqual(fs.readdirSync(away), []);
	});

	test('a link that stays INSIDE the folder is fine', () => {
		const root = folder();
		fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'inside', private: true, dependencies: { dreamteamer: VERSION } }) + '\n');
		fs.mkdirSync(path.join(root, 'node_modules'));
		fs.symlinkSync(ENGINE_ROOT, path.join(root, 'node_modules', 'dreamteamer'), 'dir');
		fs.mkdirSync(path.join(root, 'config'));
		fs.writeFileSync(path.join(root, 'config', 'gitignore'), 'secrets/\n');
		fs.symlinkSync(path.join('config', 'gitignore'), path.join(root, '.gitignore'));
		const r = dt(root, 'init', '--ready', VERSION);
		assert.equal(r.code, 0, r.stdout + r.stderr);
		assert.match(fs.readFileSync(path.join(root, 'config', 'gitignore'), 'utf8'), /^secrets\/\n(.*\n)*\.dreamteamer\/\n/);
	});
});

describe('dt init --ready in an EXISTING, dirty repo', () => {
	test('nothing is committed; staged, unstaged and untracked work, HEAD, origin and git config are exactly as they were', () => {
		const root = folder();
		git(root, ['init', '-q', '-b', 'main']);
		git(root, ['config', 'user.email', 'someone@example.invalid']);
		git(root, ['config', 'user.name', 'Someone']);
		// the engine already installed (npm ran earlier), so the CLI path runs no npm at all
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

		const r = dt(root, 'init', '--ready', VERSION);
		assert.equal(r.code, 0, r.stdout + r.stderr);
		assert.match(r.stdout, new RegExp(`✔ dependencies: dreamteamer@${VERSION.replace(/\./g, '\\.')} and every declared package installed`));
		assert.match(r.stdout, /— git: nothing was committed/);
		assert.equal(git(root, ['rev-parse', 'HEAD']), head);
		assert.equal(git(root, ['rev-list', '--count', 'HEAD']), '1');
		assert.equal(git(root, ['remote', 'get-url', 'origin']), 'https://example.invalid/acme.git');
		assert.equal(fs.readFileSync(path.join(root, '.git', 'config'), 'utf8'), config);
		assert.equal(git(root, ['diff', '--cached', '--name-only']), 'staged.txt');
		assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'v2, not staged\n');
		assert.equal(fs.readFileSync(path.join(root, 'untracked.txt'), 'utf8'), 'mine\n');
		const pkg = readPkg(root);
		assert.deepEqual([pkg.custom, pkg.scripts, pkg.dependencies.dreamteamer], [{ keep: true }, { build: 'make' }, VERSION]);
		assert.ok(fs.readFileSync(path.join(root, '.gitignore'), 'utf8').startsWith('node_modules/\n'), 'the existing .gitignore is appended to, never replaced');
		assert.ok(fs.existsSync(path.join(root, '.dreamteamer/manifest.yaml')));
	});
});

describe('dt init --ready refuses before it writes anything', () => {
	const untouched = (root) => fs.readdirSync(root).sort();

	test('the version is explicit, exact, and the running engine\'s own', () => {
		const root = folder();
		for (const args of [['--ready'], ['--ready', 'latest'], ['--ready', `^${VERSION}`]]) {
			const r = dt(root, 'init', ...args);
			assert.equal(r.code, 1, args.join(' '));
			assert.match(r.stderr, /--ready needs the exact engine version to pin/);
		}
		const r = dt(root, 'init', '--ready=9.9.9');
		assert.equal(r.code, 1);
		assert.match(r.stderr, new RegExp(`--ready 9\\.9\\.9, but this is dreamteamer ${VERSION.replace(/\./g, '\\.')} — run that version itself: npx dreamteamer@9\\.9\\.9 init --ready 9\\.9\\.9`));
		assert.deepEqual(untouched(root), []);
	});

	// Each case: refused, with its reason, and the folder byte-for-byte as it was.
	const refusedAsIs = (files, why) => {
		const root = folder();
		for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); }
		const r = dt(root, 'init', '--ready', VERSION);
		assert.equal(r.code, 1, r.stdout);
		assert.match(r.stderr, why);
		assert.match(r.stderr, /init --ready never changes an existing engine|keep one declaration/);
		for (const [rel, text] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(root, rel), 'utf8'), text, rel);
		assert.deepEqual(untouched(root), [...new Set(Object.keys(files).map((f) => f.split('/')[0]))].sort());
		return root;
	};
	const pkgWith = (deps) => JSON.stringify({ name: 'old', ...deps }) + '\n';

	test('an engine of another version — declared, locked or installed — is the workspace\'s choice, never upgraded', () => {
		refusedAsIs({ 'package.json': pkgWith({ dependencies: { dreamteamer: '0.0.1' } }) }, /package\.json declares dreamteamer "0\.0\.1", which .* is not/);
		refusedAsIs({ 'package.json': pkgWith({ dependencies: { dreamteamer: '^0.1.0' } }) }, /package\.json declares dreamteamer "\^0\.1\.0"/);
		refusedAsIs({ 'node_modules/dreamteamer/package.json': '{ "name": "dreamteamer", "version": "0.0.2" }' }, /node_modules holds dreamteamer 0\.0\.2/);
		refusedAsIs({ 'package.json': pkgWith({ dependencies: { dreamteamer: VERSION } }), 'package-lock.json': '{ "packages": { "node_modules/dreamteamer": { "version": "0.0.3" } } }\n' }, /package-lock\.json locks dreamteamer 0\.0\.3/);
		refusedAsIs({ 'package.json': pkgWith({ dependencies: { dreamteamer: VERSION }, devDependencies: { dreamteamer: '0.0.4' } }) }, /declares dreamteamer twice, differently/);
	});

	// review finding: package.json declaring an OLD engine with THIS one installed returned 0 and left the
	// old declaration — the next clone installs the old engine
	test('a declaration that disagrees with the installed engine is refused, not adopted', () => {
		const root = folder();
		const text = pkgWith({ dependencies: { dreamteamer: '0.45.0' } });
		fs.writeFileSync(path.join(root, 'package.json'), text);
		fs.mkdirSync(path.join(root, 'node_modules'));
		fs.symlinkSync(ENGINE_ROOT, path.join(root, 'node_modules', 'dreamteamer'), 'dir');
		const r = dt(root, 'init', '--ready', VERSION);
		assert.equal(r.code, 1, r.stdout);
		assert.match(r.stderr, /package\.json declares dreamteamer "0\.45\.0"/);
		assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), text);
		assert.deepEqual(untouched(root), ['node_modules', 'package.json']);
	});
});

describe('legacy dt init is unchanged', () => {
	test('it commits ONLY its own files, never compiles, never installs — and the operator\'s staged work stays out of its commit', () => {
		const root = folder();
		git(root, ['init', '-q']);
		git(root, ['config', 'user.email', 'someone@example.invalid']);
		git(root, ['config', 'user.name', 'Someone']);
		fs.writeFileSync(path.join(root, 'staged.txt'), 'staged\n'); git(root, ['add', 'staged.txt']);
		const r = dt(root, 'init');
		assert.equal(r.code, 0, r.stderr);
		assert.match(r.stdout, /initialized — run `dreamteamer compile`/);
		assert.equal(git(root, ['log', '--format=%s']), `dreamteamer: init workspace ${path.basename(root)}`);
		assert.deepEqual(git(root, ['show', '--name-only', '--format=', 'HEAD']).split('\n').sort(),
			['.env.example', '.gitignore', '.vscode/extensions.json', 'modules/default/collections/notes.collection.yaml', 'modules/default/package.json', 'package.json']);
		assert.equal(git(root, ['diff', '--cached', '--name-only']), 'staged.txt');
		assert.ok(!fs.existsSync(path.join(root, '.dreamteamer')) && !fs.existsSync(path.join(root, 'node_modules')));
	});

	test('a re-run leaves a package.json that already holds the block byte-for-byte, whatever its formatting', () => {
		const root = folder();
		assert.equal(dt(root, 'init').code, 0);
		const twoSpace = JSON.stringify(readPkg(root), null, 2) + '\n';
		fs.writeFileSync(path.join(root, 'package.json'), twoSpace);
		assert.equal(dt(root, 'init').code, 0);
		assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), twoSpace);
	});
});
