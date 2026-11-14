// Shared support for the cr-dt-008 engine held-out tests (rnd/tests/dreamteamer/heldout-dt008-e-*) — written
// by the test stage from the held-out records, never by the builder. Offline, as install-modules.test.js
// runs: a compiled fixture workspace whose engine is a `file:` dependency on THIS checkout, every module
// packed into one folder of tarballs (`--from`), npm never asked a registry.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { workspace, ENGINE_ROOT, git, readFile, treeHash } from '../helpers/ws.js';
import { buildRegistry } from '../fixtures/registry/build.mjs';
import { resolveNpm } from '../../src/checkout.js';

export { ENGINE_ROOT, git, readFile, treeHash };
export const BIN = path.join(ENGINE_ROOT, 'bin', 'dreamteamer.js');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-heldout-008-'));
const HOME = path.join(SANDBOX, 'home');
fs.mkdirSync(HOME);
export const ENV = { PATH: process.env.PATH, HOME, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' };

/** The real CLI, no TTY. Never throws on a non-zero exit. */
export function run(root, args, env = {}) {
	const r = spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8', timeout: 240_000, killSignal: 'SIGKILL', env: { ...ENV, ...env } });
	return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', signal: r.signal, error: r.error };
}
export const out = (r) => `exit ${r.code}${r.signal ? ` (${r.signal})` : ''}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`;

/** A compiled fixture whose engine is a file: dependency, so npm resolves everything from disk. */
export function offline() {
	const ws = workspace();
	const pkgFile = path.join(ws.root, 'package.json');
	const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
	pkg.dependencies = { ...pkg.dependencies, dreamteamer: `file:${ENGINE_ROOT}` };
	fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, '\t') + '\n');
	// a workspace `dt init` made has a package-lock.json; the cached fixture has none, so npm writes it once
	// here — otherwise a restore's own `npm install` would be measured as a lockfile the refused call left
	const r = spawnSync(resolveNpm(), ['install', '--no-audit', '--no-fund'], { cwd: ws.root, encoding: 'utf8', env: ENV, timeout: 120_000 });
	if (r.status !== 0) throw new Error(`npm install in the fixture: ${r.stderr}`);
	git(ws.root, ['add', '-A']);
	if (git(ws.root, ['status', '--porcelain'])) git(ws.root, ['commit', '-qm', 'fixture: offline engine']);
	return ws;
}

/**
 * A copy of the offline registry (test/fixtures/registry) plus `extra` packages, each `{ name, version,
 * dreamteamer, files: { rel: text }, pkgFiles? }` — written exactly as given (`files` in package.json
 * defaults to the top-level folders/files of `files`).
 */
export function registry(extra = []) {
	const dest = buildRegistry(fs.mkdtempSync(path.join(SANDBOX, 'reg-')));
	addToRegistry(dest, extra);
	return dest;
}
export function addToRegistry(dest, packages) {
	for (const { files = {}, pkgFiles, ...manifest } of packages) {
		const src = fs.mkdtempSync(path.join(SANDBOX, `src-${manifest.name.replace(/[@/]/g, '-')}-${manifest.version}-`));
		const tops = [...new Set(Object.keys(files).map((f) => f.split('/')[0]))];
		fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ description: `${manifest.name} ${manifest.version}`, files: pkgFiles ?? tops, ...manifest }, null, '\t') + '\n');
		for (const [rel, text] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
			fs.writeFileSync(path.join(src, rel), text);
		}
		const r = spawnSync(resolveNpm(), ['pack', src, '--pack-destination', dest, '--silent'], { encoding: 'utf8', env: { ...process.env, ...ENV }, timeout: 60_000 });
		if (r.status !== 0) throw new Error(`npm pack ${manifest.name} failed: ${r.stderr}`);
	}
	return dest;
}
/** A minimal collection descriptor, as the registry fixtures write theirs. */
export const collection = (name, extra = '') => `name: ${name}\ndescription: A ${name} record.\nids:\n  from: '{{ title | slug }}'\nfields:\n  title:\n    type: string\n    required: true\n${extra}`;

export const installed = (root, name) => { try { return JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version; } catch { return null; } };
/** The version package.json pins `name` at — offline, the version in the one tarball a `file:` spec names. */
export const pinOf = (root, name) => {
	const spec = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies?.[name];
	if (spec == null) return null;
	const m = /^file:.*-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.tgz$/.exec(spec);
	return m ? m[1] : spec;
};
export const sha = (root, rel) => { const t = (() => { try { return fs.readFileSync(path.join(root, rel)); } catch { return null; } })(); return t === null ? null : createHash('sha256').update(t).digest('hex'); };
const listing = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return null; } };
/** What "nothing was written" is measured against: the npm files, node_modules/@fix, nav.yaml, git. */
export function snapshot(root) {
	return {
		pkg: sha(root, 'package.json'),
		lock: sha(root, 'package-lock.json'),
		fix: listing(path.join(root, 'node_modules', '@fix')),
		nav: sha(root, 'nav.yaml'),
		status: git(root, ['status', '--porcelain']),
		head: git(root, ['rev-parse', 'HEAD']),
	};
}
export function npmUninstall(root, name) {
	const r = spawnSync(resolveNpm(), ['uninstall', name, '--no-audit', '--no-fund'], { cwd: root, encoding: 'utf8', env: ENV, timeout: 120_000 });
	if (r.status !== 0) throw new Error(`npm uninstall ${name}: ${r.stderr}`);
}
export const lastFiles = (root) => git(root, ['show', '--name-only', '--pretty=', 'HEAD']).split('\n').filter(Boolean);
export const commitAll = (root, msg) => { git(root, ['add', '-A']); if (git(root, ['status', '--porcelain'])) git(root, ['commit', '-qm', msg]); };
export const noStack = (text) => !/\n\s+at .+[:(]\d+:\d+\)?/.test(text) && !/TypeError|ReferenceError|RangeError|Maximum call stack/.test(text);
