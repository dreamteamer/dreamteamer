// `dt install <spec…>` through the real binary, offline: every module comes from a folder of
// tarballs (`--from`), the engine itself is a `file:` dependency, and npm never asks a registry.
// The scenarios are the design's install contract, step by step: resolve and refuse before npm,
// npm --save-exact, verify, compile (and restore on refusal), the safe setup, the scoped commit.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { workspace, ENGINE_ROOT, git, treeHash, readFile } from '../helpers/ws.js';
import { buildRegistry } from '../fixtures/registry/build.mjs';
import { openWorkspace } from '../../src/api.js';
import { installModules } from '../../src/install-modules.js';

const BIN = path.join(ENGINE_ROOT, 'bin', 'dreamteamer.js');
let REG;
before(() => { REG = buildRegistry(); });

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-home-'));
const run = (root, args, env = {}) => {
	const home = HOME;
	const r = spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8', timeout: 180_000, killSignal: 'SIGKILL', env: { PATH: process.env.PATH, HOME: home, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', ...env } });
	return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', home };
};
/** A compiled fixture whose engine is a file: dependency, so npm resolves everything from disk. */
function offline() {
	const ws = workspace();
	const pkgFile = path.join(ws.root, 'package.json');
	const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
	pkg.dependencies = { ...pkg.dependencies, dreamteamer: `file:${ENGINE_ROOT}` };
	fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, '\t') + '\n');
	git(ws.root, ['add', '-A']);
	if (git(ws.root, ['status', '--porcelain'])) git(ws.root, ['commit', '-qm', 'fixture: offline engine']);
	return ws;
}
const installed = (root, name) => { try { return JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version; } catch { return null; } };
const lastCommit = (root) => ({ subject: git(root, ['log', '-1', '--pretty=%s']), files: git(root, ['show', '--name-only', '--pretty=', 'HEAD']).split('\n').filter(Boolean).sort() });

describe('dt install <spec> — closure, compile, safe setup, scoped commit', () => {
	test('a module and the module it declares it needs, pinned, compiled, committed in one scoped commit', () => {
		const ws = offline();
		const r = run(ws.root, ['install', '@fix/a', '--from', REG]);
		assert.equal(r.code, 0, r.stderr + r.stdout);
		assert.match(r.stdout, /install: @fix\/b@1\.0\.0, @fix\/a@1\.1\.0/, 'dependencies first, the newest in the folder');
		assert.equal(installed(ws.root, '@fix/a'), '1.1.0', 'the newest in the folder');
		assert.equal(installed(ws.root, '@fix/b'), '1.0.0', 'the declared dependency');
		assert.ok(fs.existsSync(path.join(ws.root, '.dreamteamer', 'collections', 'fixas.collection.yaml')), 'compiled');
		const c = lastCommit(ws.root);
		assert.match(c.subject, /^dreamteamer: install @fix\/b, @fix\/a$/);
		// the two files npm rewrote, and .env.example when compile touched it — never .env, never data
		assert.ok(c.files.every((f) => ['.env.example', 'package-lock.json', 'package.json'].includes(f)), c.files.join(','));
		assert.ok(c.files.includes('package.json') && c.files.includes('package-lock.json'));
		assert.equal(git(ws.root, ['status', '--porcelain']), '', 'nothing left uncommitted');
		// again: nothing to do, nothing changed
		const before = treeHash(ws.root);
		const again = run(ws.root, ['install', '@fix/a', '--from', REG]);
		assert.equal(again.code, 0, again.stderr);
		assert.match(again.stdout, /already installed/);
		assert.equal(treeHash(ws.root), before);
	});

	test('a core and a module it provides are refused in both orders, before npm, with nothing written', () => {
		const a = offline();
		assert.equal(run(a.root, ['install', '@fix/core', '--from', REG]).code, 0);
		const h = treeHash(a.root);
		const r = run(a.root, ['install', '@fix/a', '--from', REG]);
		assert.equal(r.code, 1);
		assert.match(r.stderr, /@fix\/core already provides @fix\/(a|b)/);
		assert.equal(treeHash(a.root), h);
		// the refusal comes by NAME, before any dependency is looked up: a folder holding only core and a
		// (no b) still names core rather than complaining that b is missing
		const only = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-only-'));
		for (const f of fs.readdirSync(REG).filter((n) => /^fix-(core|a)-/.test(n))) fs.copyFileSync(path.join(REG, f), path.join(only, f));
		const byName = run(a.root, ['install', '@fix/a', '--from', only]);
		assert.equal(byName.code, 1);
		assert.match(byName.stderr, /@fix\/core already provides @fix\/a/);
		const b = offline();
		assert.equal(run(b.root, ['install', '@fix/a', '--from', REG]).code, 0);
		const hb = treeHash(b.root);
		const rb = run(b.root, ['install', '@fix/core', '--from', REG]);
		assert.equal(rb.code, 1);
		assert.match(rb.stderr, /@fix\/core provides @fix\/a, which is installed/);
		assert.equal(treeHash(b.root), hb);
	});

	test('a ring, an engine floor this engine does not meet, a package that is not a module, a name the folder lacks', () => {
		const ws = offline();
		const h = treeHash(ws.root);
		const ring = run(ws.root, ['install', '@fix/ring-x', '--from', REG]);
		assert.equal(ring.code, 1);
		assert.match(ring.stderr, /ring in dreamteamer\.dependencies: @fix\/ring-x → @fix\/ring-y → @fix\/ring-x/);
		const old = run(ws.root, ['install', '@fix/old', '--from', REG]);
		assert.equal(old.code, 1);
		assert.match(old.stderr, /@fix\/old@1\.0\.0 needs engine ">=99\.0\.0" — this is [\d.]+; choose a version: dt install @fix\/old@<version>/);
		const plain = run(ws.root, ['install', 'plain', '--from', REG]);
		assert.equal(plain.code, 1);
		assert.match(plain.stderr, /plain@1\.0\.0 is not a dreamteamer module \(no dreamteamer key in its package\.json\)/);
		const none = run(ws.root, ['install', '@fix/nope', '--from', REG]);
		assert.equal(none.code, 1);
		assert.match(none.stderr, /no @fix\/nope in /);
		assert.equal(treeHash(ws.root), h, 'nothing was written by any refusal');
	});

	test('a dependency that is not a module is refused naming BOTH: the package and the module that needs it', () => {
		const ws = offline();
		const r = run(ws.root, ['install', '@fix/needs-plain', '--from', REG]);
		assert.equal(r.code, 1);
		assert.match(r.stderr, /plain@1\.0\.0 is not a dreamteamer module .* — needed by @fix\/needs-plain/);
		assert.equal(installed(ws.root, 'plain'), null); assert.equal(installed(ws.root, '@fix/needs-plain'), null);
	});

	test('two explicit specs of one module at different versions are refused before npm, naming both', () => {
		const ws = offline();
		const r = run(ws.root, ['install', '@fix/a@1.0.0', '@fix/a@1.1.0', '--from', REG]);
		assert.equal(r.code, 1, r.stdout);
		assert.match(r.stderr, /@fix\/a is asked for at 1\.0\.0 and at 1\.1\.0 — one version per call/);
		assert.equal(installed(ws.root, '@fix/a'), null);
		assert.equal(git(ws.root, ['status', '--porcelain']), '');
	});

	test('when the restoring npm itself fails after a compile refusal, the message says what is NOT restored instead of claiming the pre-image', async () => {
		const ws = offline();
		assert.equal(run(ws.root, ['install', '@fix/b', '--from', REG]).code, 0);
		// a package whose compile will refuse (a collection colliding with the skeleton's), and an npm that fails on the restore
		const handle = await openWorkspace(ws.root);
		const calls = [];
		const npm = (() => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-npm-')); const f = path.join(dir, 'npm'); fs.writeFileSync(f, `#!/usr/bin/env node\nconst { spawnSync } = require('child_process');\nconst args = process.argv.slice(2);\nif (args[0] === '--version') { console.log('11.0.0'); process.exit(0); }\nif (args.length === 3 && args[0] === 'install') process.exit(42);\nconst r = spawnSync('npm', args, { stdio: 'inherit' }); process.exit(r.status ?? 1);\n`, { mode: 0o755 }); return f; })();
		const log = [];
		const stderr = console.error; const err = []; console.error = (...a) => err.push(a.join(' '));
		let code;
		try { code = await installModules(handle, [path.join(REG, 'probe-collide-1.0.0.tgz')], { open: openWorkspace, npm, log: (l) => log.push(l) }); } finally { console.error = stderr; }
		assert.equal(code, 1);
		const text = err.join('\n');
		assert.match(text, /install refused/);
		assert.match(text, /restore FAILED \(npm exited 42\)/, 'the failed restore is named, not hidden');
		assert.doesNotMatch(text, /are as before the call/);
	});

	test('a compile refusal restores package.json, the lockfile and node_modules, and says so', () => {
		const ws = offline();
		assert.equal(run(ws.root, ['install', '@fix/b', '--from', REG]).code, 0);
		const pkg = readFile(ws.root, 'package.json'), lock = readFile(ws.root, 'package-lock.json');
		const mods = fs.readdirSync(path.join(ws.root, 'node_modules')).sort();
		const r = run(ws.root, ['install', '@probe/collide', '--from', REG]);
		assert.equal(r.code, 1);
		assert.match(r.stderr, /install refused: compile error: name collision on collection "notes"/);
		assert.match(r.stderr, /package\.json, package-lock\.json and node_modules are as before the call/);
		assert.equal(readFile(ws.root, 'package.json'), pkg);
		assert.equal(readFile(ws.root, 'package-lock.json'), lock);
		assert.deepEqual(fs.readdirSync(path.join(ws.root, 'node_modules')).sort(), mods);
		assert.equal(git(ws.root, ['status', '--porcelain']), '');
	});

	test('the safe part of setup runs on install; a required input missing without a TTY is exit 3; a repeat changes nothing', () => {
		const ws = offline();
		const r = run(ws.root, ['install', '@probe/setup', '--from', REG, '--input', 'label=demo']);
		assert.equal(r.code, 0, r.stderr + r.stdout);
		assert.match(r.stdout, /✔ make-home — wrote \.env/);
		assert.match(r.stdout, /… fetch \(needs --allow download\)/);
		assert.match(readFile(ws.root, '.env'), /^PROBE_LABEL=demo$/m);
		// .env is ignored, never in the install commit
		assert.ok(!lastCommit(ws.root).files.includes('.env'));
		const before = treeHash(ws.root);
		const again = run(ws.root, ['install', '@probe/setup', '--from', REG, '--input', 'label=demo']);
		assert.equal(again.code, 0);
		assert.equal(treeHash(ws.root), before);
		const w = offline();
		const n = run(w.root, ['install', '@probe/setup', '--from', REG, '--no-input']);
		assert.equal(n.code, 3, n.stderr);
		assert.ok(fs.existsSync(path.join(w.root, 'node_modules', '@probe', 'setup')), 'installed and compiled before the input was asked for');
		assert.match(n.stdout, /needs input: label/);
	});

	test('a folder spec is a development link: status says linked, and a pin is refused as linked', () => {
		const ws = offline();
		const r = run(ws.root, ['install', path.join(REG, '..', 'nonexistent-to-force-folder-form')].slice(0, 0).concat(['install', path.join(ENGINE_ROOT, 'test', 'fixtures', 'registry', 'src', 'fix-b-1.0.0')]));
		assert.equal(r.code, 0, r.stderr + r.stdout);
		assert.ok(fs.lstatSync(path.join(ws.root, 'node_modules', '@fix', 'b')).isSymbolicLink());
		const s = run(ws.root, ['status']);
		assert.match(s.stdout, /@fix\/b\s+node_modules.*linked/);
		const p = run(ws.root, ['install', '@fix/b@1.0.0', '--from', REG]);
		assert.equal(p.code, 1);
		assert.match(p.stderr, /@fix\/b is a development link \(not pinned\)/);
	});

	test('an npm below the floor is refused by name', async () => {
		// resolveNpm prefers the npm beside the running node, so the floor is exercised through the
		// injectable npm path rather than a PATH shim
		const ws = offline();
		const shim = path.join(ws.root, 'npm'); fs.writeFileSync(shim, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 6.14.18; exit 0; fi\nexit 1\n', { mode: 0o755 });
		const errors = [];
		const orig = console.error; console.error = (...a) => errors.push(a.join(' '));
		let code;
		try { code = await installModules(await openWorkspace(ws.root), ['@fix/b', '--from', REG], { open: openWorkspace, npm: shim, log: () => {} }); } finally { console.error = orig; }
		assert.equal(code, 1);
		assert.match(errors.join('\n'), /dt install needs npm >=7 \(this is 6\.14\.18\)/);
	});

	test('interrupted after compile, before the commit: the next run commits what is pending and runs the setup; a third changes nothing', () => {
		const ws = offline();
		assert.equal(run(ws.root, ['install', '@fix/b', '--from', REG]).code, 0);
		// the state a kill, a Ctrl-D at a prompt or a usage error leaves: compiled, npm's two files modified, no commit
		git(ws.root, ['reset', '-q', '--mixed', 'HEAD~1']);
		assert.match(git(ws.root, ['status', '--porcelain']), /package\.json/);
		const r = run(ws.root, ['install', '@fix/b', '--from', REG]);
		assert.equal(r.code, 0, r.stderr + r.stdout);
		assert.match(r.stdout, /already installed: @fix\/b — .*committed/);
		assert.equal(git(ws.root, ['status', '--porcelain']), '', 'the pending files were committed');
		assert.equal(lastCommit(ws.root).subject, 'dreamteamer: install @fix/b');
		const before = treeHash(ws.root);
		const third = run(ws.root, ['install', '@fix/b', '--from', REG]);
		assert.equal(third.code, 0);
		assert.match(third.stdout, /nothing to do/);
		assert.equal(treeHash(ws.root), before);
	});

	test('a mistyped --input is ignored with a warning, never an abort after npm: the install is committed and names what is still needed; the corrected re-run runs the setup', () => {
		const ws = offline();
		const r = run(ws.root, ['install', '@probe/setup', '--from', REG, '--input', 'lable=demo', '--no-input']);
		assert.equal(r.code, 3, r.stderr + r.stdout);
		assert.match(r.stdout + r.stderr, /⚠ --input lable= names no input of probe — ignored/);
		assert.match(r.stdout, /needs input: label/);
		assert.equal(git(ws.root, ['status', '--porcelain']), '', 'committed despite the typo');
		assert.equal(lastCommit(ws.root).subject, 'dreamteamer: install @probe/setup');
		const again = run(ws.root, ['install', '@probe/setup', '--from', REG, '--input', 'label=demo', '--no-input']);
		assert.equal(again.code, 0, again.stderr + again.stdout);
		assert.match(again.stdout, /✔ make-home — wrote \.env/);
		assert.match(readFile(ws.root, '.env'), /^PROBE_LABEL=demo$/m);
		assert.equal(git(ws.root, ['status', '--porcelain']), '');
	});

	test('interrupted after npm, before compile: the next run finishes and a third changes nothing', async () => {
		const ws = offline();
		const handle = await openWorkspace(ws.root);
		let thrown = null;
		try {
			await installModules(handle, ['@fix/b', '--from', REG], { open: openWorkspace, log: () => {}, hooks: { afterNpm: () => { throw new Error('simulated power cut'); } } });
		} catch (e) { thrown = e.message; }
		assert.match(String(thrown), /simulated power cut/);
		assert.equal(installed(ws.root, '@fix/b'), '1.0.0', 'npm had finished');
		assert.ok(!fs.existsSync(path.join(ws.root, '.dreamteamer', 'collections', 'fixbs.collection.yaml')), 'compile had not');
		const r = run(ws.root, ['install', '@fix/b', '--from', REG]);
		assert.equal(r.code, 0, r.stderr + r.stdout);
		assert.ok(fs.existsSync(path.join(ws.root, '.dreamteamer', 'collections', 'fixbs.collection.yaml')));
		assert.equal(git(ws.root, ['status', '--porcelain']), '');
		const before = treeHash(ws.root);
		assert.equal(run(ws.root, ['install', '@fix/b', '--from', REG]).code, 0);
		assert.equal(treeHash(ws.root), before);
	});
});
