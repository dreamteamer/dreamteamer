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
	git(ws.root, ['add', '-A']); git(ws.root, ['commit', '-qm', 'fixture: offline engine']);
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
