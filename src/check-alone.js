// `dt check modules/<id> --alone` — is this inline module publishable? (cr-dt-007, G3, D63, D65)
//
// The gate does to a module what a stranger's workspace will: packs it with `npm pack` (so its `files`
// list is what is judged), `init`s a fresh workspace on THIS engine, `dt install`s the tarball with only
// the module's declared `dreamteamer.dependencies` (each packed from this workspace — `modules/` or
// `node_modules` — never fetched, so the gate is offline), then compiles and checks it and prints the
// module's setup line. It learns nothing about the module beyond its manifest, and it runs no package
// script of the author's (D63: the author's `npm test` is the author's).
//
//   exit 0  publishable — including a unit that still needs an input a stranger supplies later (install 3)
//   exit 1  refused, the first reason named: a dependency not held here, a floor above this engine, a
//           refused install, a compile error, a check violation
//   exit 2  usage
//
// Dispatched from src/cli.js before the host workspace is opened: a module whose dependency is
// missing would fail the HOST's compile, and the gate's whole point is to say so by name.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveNpm, childEnv } from './checkout.js';
import { KINDS, kindDir } from './compile.js';

const ENGINE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const IDENTITY = { GIT_AUTHOR_NAME: 'dreamteamer check', GIT_AUTHOR_EMAIL: 'check@example.invalid', GIT_COMMITTER_NAME: 'dreamteamer check', GIT_COMMITTER_EMAIL: 'check@example.invalid' };

/** Run `engine`'s CLI in `cwd`, output captured, no stdin. */
export function engineRun(engine, cwd, args, { env = {}, timeoutMs = 300_000, input } = {}) {
	const r = spawnSync(process.execPath, [path.join(engine, 'bin', 'dreamteamer.js'), ...args], {
		cwd, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL',
		env: { ...process.env, ...IDENTITY, NO_COLOR: '1', ...env },
		...(input !== undefined ? { input } : { stdio: ['ignore', 'pipe', 'pipe'] }),
	});
	return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** A fresh workspace in `root` on `engine`: the engine declared as a `file:` dependency and linked
 *  before `init`, so init finds it present and asks no registry. Throws with init's words on failure. */
export function freshWorkspace(root, engine = ENGINE) {
	fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: path.basename(root).toLowerCase().replace(/[^a-z0-9-]/g, '-'), private: true, dependencies: { dreamteamer: `file:${engine}` } }, null, '\t') + '\n');
	fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
	fs.symlinkSync(engine, path.join(root, 'node_modules', 'dreamteamer'), 'dir');
	const r = engineRun(engine, root, ['init', '--no-input'], { timeoutMs: 180_000 });
	if (r.status !== 0) throw new Error(`dt init failed (exit ${r.status}): ${(r.stderr || r.stdout).trim().split('\n')[0]}`);
	return root;
}

const readPkg = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));

/** Where this workspace holds a package by name: an inline module whose package.json names it, or node_modules/<name>. */
function locate(root, name) {
	const inline = path.join(root, 'modules');
	if (fs.existsSync(inline)) for (const d of fs.readdirSync(inline)) {
		try { if (readPkg(path.join(inline, d)).name === name) return path.join(inline, d); } catch { /* not a module folder */ }
	}
	const npm = path.join(root, 'node_modules', name);
	return fs.existsSync(path.join(npm, 'package.json')) ? fs.realpathSync(npm) : null;
}

/** Pack `dir` into `dest`; returns the tarball's name and the package-relative paths it ships (null
 *  when npm's --json listing does not parse — the shipped-sources judgement is then skipped). */
function npmPack(npm, dir, dest) {
	const before = new Set(fs.readdirSync(dest));
	const r = spawnSync(npm, ['pack', '--json', '--silent', '--ignore-scripts', '--pack-destination', dest], { cwd: dir, encoding: 'utf8', timeout: 120_000, env: childEnv() });
	if (r.status !== 0) throw new Error(`npm pack failed in ${dir}: ${(r.stderr || r.stdout).trim().split('\n')[0]}`);
	let files = null;
	try { files = JSON.parse(r.stdout)[0].files.map((f) => f.path.split(path.sep).join('/')); } catch { /* an npm without --json for pack */ }
	return { file: fs.readdirSync(dest).find((f) => f.endsWith('.tgz') && !before.has(f)), files };
}

/** Every file under `rel` in `dir` (dotfiles left out — npm never packs .DS_Store and the like), `/`-joined. */
function filesUnder(dir, rel) {
	const out = [];
	const walk = (r) => {
		for (const e of fs.readdirSync(path.join(dir, r), { withFileTypes: true })) {
			if (e.name.startsWith('.') || e.name === 'node_modules') continue;
			const sub = `${r}/${e.name}`;
			if (e.isDirectory()) walk(sub); else if (e.isFile()) out.push(sub);
		}
	};
	if (fs.existsSync(path.join(dir, rel)) && fs.statSync(path.join(dir, rel)).isDirectory()) walk(rel);
	return out;
}

/**
 * What the source authors that compile would read and the tarball does not ship — the kind folders, a UI
 * bundle and the nav fragment the manifest names — as `{ missing, folder }`, or null when it all ships.
 * A folder left out of the package's `files` list is not published: a stranger installs a module without it.
 */
export function unshippedSources(dir, manifest, shipped) {
	if (!shipped) return null;
	const has = new Set(shipped);
	const authored = [];
	for (const k of KINDS) authored.push(...filesUnder(dir, path.relative(dir, kindDir(dir, k)).split(path.sep).join('/')));
	for (const ui of ['ui', 'studio']) authored.push(...filesUnder(dir, ui));
	const nav = manifest.dreamteamer?.nav;
	if (typeof nav === 'string' && fs.existsSync(path.join(dir, nav))) authored.push(nav.split(path.sep).join('/').replace(/^\.\//, ''));
	const missing = authored.filter((f) => !has.has(f));
	return missing.length ? { missing, folder: missing[0].split('/')[0] } : null;
}
const unshippedLine = (name, u) => `${name} does not ship ${u.missing[0]}${u.missing.length > 1 ? ` (and ${u.missing.length - 1} more)` : ''} — package.json "files" leaves out ${u.folder}, so a stranger's install would have none of it; add "${u.folder}" to "files"`;

/** The gate. `target` is the positional (`modules/<id>`); returns the exit code. */
export function checkAlone(ws, { target, keep = false, log = console.log, error = console.error } = {}) {
	const usage = (m) => { error(`✖ ${m}`); return 2; };
	if (!target) return usage('check --alone takes modules/<id> — the inline module to judge');
	const m = /^modules\/([^/]+)\/?$/.exec(target);
	const dir = m && path.join(ws.root, 'modules', m[1]);
	if (!dir || !fs.existsSync(path.join(dir, 'package.json'))) return usage(`${target} is not an inline module of this workspace — check --alone takes modules/<id>`);
	const label = `modules/${m[1]}`;
	let pkg;
	try { pkg = readPkg(dir); } catch (e) { error(`✖ ${label}: package.json does not parse — ${e.message}`); return 1; }
	if (!pkg.dreamteamer) { error(`✖ ${label}: package.json has no "dreamteamer" block — the engine would not see it as a module`); return 1; }
	const npm = resolveNpm();
	if (!npm) { error(`✖ ${label}: no npm beside this node or on PATH — the gate packs the module with it`); return 1; }

	const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dt-check-alone-')));
	const refuse = (why) => { error(`✖ ${label}: ${why}`); if (keep) log(`  kept: ${path.join(tmp, 'ws')}`); else fs.rmSync(tmp, { recursive: true, force: true }); return 1; };
	try {
		// the module and its declared dependency closure, packed into one folder `dt install --from` reads
		const from = path.join(tmp, 'from');
		fs.mkdirSync(from);
		const own = unshippedSources(dir, pkg, npmPack(npm, dir, from).files);
		if (own) return refuse(unshippedLine(pkg.name, own));
		const deps = [];
		const seen = new Set([pkg.name]);
		// a module preset's members are packed like dependencies (CR-dt-008): install walks them at their
		// pins. Each need remembers who listed it and under which key, so a missing one is named rightly.
		const needs = (p) => [
			...(p.dreamteamer?.dependencies ?? []).map((name) => ({ name, by: p.name })),
			...Object.entries(p.dreamteamer?.preset ?? {}).map(([name, pin]) => ({ name, by: p.name, pin })),
		];
		const queue = needs(pkg);
		while (queue.length) {
			const { name, by, pin } = queue.shift();
			if (seen.has(name)) continue;
			seen.add(name);
			const at = locate(ws.root, name);
			if (!at) {
				return refuse(pin !== undefined
					? `module preset member ${name}@${pin} (pinned in ${by}'s dreamteamer.preset) is not here — neither modules/ nor node_modules holds it; bring it back, or drop it from dreamteamer.preset`
					: `dependency ${name} is not installed here — install it, or drop it from dreamteamer.dependencies`);
			}
			const packed = npmPack(npm, at, from);
			const theirs = unshippedSources(at, readPkg(at), packed.files);
			if (theirs) return refuse(`${pin !== undefined ? 'module preset member' : 'dependency'} ${unshippedLine(name, theirs)}`);
			deps.push(name);
			queue.push(...needs(readPkg(at)));
		}
		// a fresh workspace on this engine, the module installed the way a stranger installs it
		const root = path.join(tmp, 'ws');
		fs.mkdirSync(root);
		freshWorkspace(root);
		const inst = engineRun(ENGINE, root, ['install', pkg.name, '--from', from, '--no-input']);
		if (inst.status !== 0 && inst.status !== 3) return refuse((inst.stderr || inst.stdout).trim().split('\n').find((l) => l.trim()) ?? `dt install exited ${inst.status}`);
		const comp = engineRun(ENGINE, root, ['compile']);
		if (comp.status !== 0) return refuse(`compile: ${(comp.stderr || comp.stdout).trim().split('\n')[0]}`);
		const chk = engineRun(ENGINE, root, ['check']);
		if (chk.status !== 0) return refuse(`check: ${(chk.stdout + chk.stderr).trim().split('\n').find((l) => l.startsWith('✖')) ?? `exited ${chk.status}`}`);
		// the module's setup line(s), as a stranger's `dt status` will draw them
		const status = engineRun(ENGINE, root, ['status']);
		const setup = (status.stdout.split('setup:\n')[1] ?? '').split('\n').filter((l) => l.startsWith('  ') && !/^\s+dreamteamer\b/.test(l));
		log(`✔ ${label} is publishable — packed, installed alone${deps.length ? ` (with ${deps.join(', ')})` : ''}, compiled, checked`);
		for (const l of setup) log(l);
		if (keep) log(`  kept: ${root}`); else fs.rmSync(tmp, { recursive: true, force: true });
		return 0;
	} catch (e) {
		return refuse(e.message);
	}
}
