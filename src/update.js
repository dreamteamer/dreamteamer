// `dt update <name>[@<version>] | --engine` — move ONE pin forward on purpose: an npm module to the
// latest release within its ranges (or to the named version), or the engine itself. Re-pinned
// exactly, closure-checked exactly as `dt install` checks it, compiled, committed with install's
// pathspec. A downgrade needs `--allow downgrade`; a development link is skipped and named. Nothing
// here runs on its own, and `dt update` with no target keeps its meaning: git modules fast-forward.
// A module update is install's steps 2–6 on the whole resolved closure, so a version that adds a
// dependency brings it in and a version that adds a setup unit runs its safe part.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { resolveNpm, childEnv } from './checkout.js';
import { readSpecManifest, resolveClosure, installedModules, compareVersions, InstallRefusal, npmFloor, npmAndCompile, printUnitResults } from './install-modules.js';
import { EXIT } from './setup.js';
import { moduleIdOf } from './compile.js';

const gitOk = (root, args) => { try { execFileSync('git', args, { cwd: root, stdio: 'ignore' }); return true; } catch { return false; } };

/**
 * `updateModules(ws, { name, version, engine, allow, from }, { open, npm, log })` → exit code.
 * `name` is a package name (with `version` the exact version asked for, or null for latest);
 * `engine: true` targets `dreamteamer` itself.
 */
export async function updateModules(ws, { name = null, version = null, engine = false, allow = new Set(), from = null, noCommit = false } = {}, { open, npm = resolveNpm(), log = console.log, processEnv = process.env } = {}) {
	if (typeof open !== 'function') throw new Error('updateModules: opts.open is required');
	const floor = npmFloor(npm);
	if (floor) { console.error(`✖ ${floor}`); return EXIT.failed; }
	const target = engine ? 'dreamteamer' : name;
	const installed = installedModules(ws);
	const here = engine
		? (() => { try { return { name: 'dreamteamer', version: JSON.parse(fs.readFileSync(path.join(ws.root, 'node_modules', 'dreamteamer', 'package.json'), 'utf8')).version, linked: fs.lstatSync(path.join(ws.root, 'node_modules', 'dreamteamer')).isSymbolicLink() }; } catch { return null; } })()
		: installed.get(target);
	if (!here) { console.error(`✖ ${target} is not installed — dt install ${target}`); return EXIT.failed; }
	if (here.linked) { log(`— ${target}: a development link — skipped (not pinned; remove the link to pin a version)`); return EXIT.done; }
	let entry;
	try { entry = readSpecManifest(version ? `${target}@${version}` : target, { from, npm, cwd: ws.root }); } catch (e) { if (e instanceof InstallRefusal) { console.error(`✖ ${e.message}`); return EXIT.failed; } throw e; }
	const next = entry.manifest.version;
	if (next === here.version) { log(`✔ ${target} is already ${next} — nothing to do`); return EXIT.done; }
	if (compareVersions(next, here.version) < 0 && !allow.has('downgrade')) { console.error(`✖ ${target} ${here.version} → ${next} is a downgrade — say so: dt update ${target}@${next} --allow downgrade`); return EXIT.failed; }
	const subject = `dreamteamer: update ${target} ${here.version} → ${next}`;
	if (engine) {
		// the engine itself: npm, then compile with the NEW engine — this process is the old one
		log(`▶ update: ${target} ${here.version} → ${next}`);
		const r = spawnSync(npm, ['install', '--save-exact', '--no-audit', '--no-fund', entry.spec], { cwd: ws.root, stdio: 'inherit', env: childEnv(), timeout: 600_000 });
		if (r.status !== 0) { console.error(`✖ npm exited ${r.status ?? r.error?.message} — run the same command again to resume`); return EXIT.failed; }
		let got = null;
		try { got = JSON.parse(fs.readFileSync(path.join(ws.root, 'node_modules', 'dreamteamer', 'package.json'), 'utf8')).version; } catch { /* missing */ }
		if (got !== next) { console.error(`✖ npm exited 0, but node_modules/dreamteamer is ${got ?? 'missing'}, not ${next}`); return EXIT.failed; }
		const c = spawnSync(process.execPath, [path.join(ws.root, 'node_modules', 'dreamteamer', 'bin', 'dreamteamer.js'), 'compile'], { cwd: ws.root, stdio: 'inherit', env: childEnv(), timeout: 600_000 });
		if (c.status !== 0) { console.error(`✖ compile with dreamteamer ${next} exited ${c.status} — the pin moved; fix what it reports, then dt compile`); return EXIT.failed; }
		let committed = null;
		if (!noCommit && gitOk(ws.root, ['rev-parse', '--git-dir'])) {
			const paths = ['package.json', 'package-lock.json', '.env.example'].filter((rel) => fs.existsSync(path.join(ws.root, rel)));
			if (gitOk(ws.root, ['add', '--', ...paths]) && gitOk(ws.root, ['commit', '--quiet', '-m', subject, '--', ...paths])) committed = paths;
		}
		log(`✔ ${target} ${here.version} → ${next} — compiled${committed ? `, committed (${committed.join(', ')})` : ', not committed'}`);
		return EXIT.done;
	}
	// a module: install one pin later — the closure check exactly as install step 1 (with the target
	// itself out of the installed map, so "installed at another version" does not refuse the very move
	// being asked for), then install's steps 2–6 on the WHOLE resolved list: a version that adds a
	// dreamteamer.dependencies entry brings the dependency in, compiled and committed with it, and a
	// version that adds a setup unit runs its safe part
	//
	// A MODULE PRESET (CR-dt-008): each installed member at another version than the new pin leaves the
	// installed map too, so it is re-walked at that pin instead of refusing as "installed at another
	// version"; a member the INSTALLED version listed and the operator uninstalled is skipped (removed
	// on purpose); a member new to this version — and every member on a first expansion, when the
	// installed version was no preset — is walked and installed.
	const installedMap = here.manifest?.dreamteamer?.preset;
	const newMap = entry.manifest.dreamteamer?.preset ?? {};
	const moving = new Set(Object.entries(newMap).filter(([n, v]) => installed.has(n) && installed.get(n).version !== v).map(([n]) => n));
	const skipMembers = new Set(Object.keys(newMap).filter((n) => !installed.has(n) && installedMap && n in installedMap));
	const others = new Map([...installed].filter(([n]) => n !== target && !moving.has(n)));
	let plan;
	try { plan = resolveClosure([entry.spec], { installed: others, skipMembers, from, npm, cwd: ws.root }); } catch (e) { if (e instanceof InstallRefusal) { console.error(`✖ ${e.message}`); return EXIT.failed; } throw e; }
	// a member moved below what is installed is a downgrade, said on purpose like the target's own
	for (const e of plan.list) {
		const n = e.manifest.name, was = installed.get(n)?.version;
		if (n === target || !was || compareVersions(e.manifest.version, was) >= 0 || allow.has('downgrade')) continue;
		console.error(`✖ ${n} ${was} → ${e.manifest.version} is a downgrade (module preset ${moduleIdOf(target)} names ${e.manifest.version}) — say so: dt update ${target}@${next} --allow downgrade`);
		return EXIT.failed;
	}
	const names = plan.list.map((e) => e.manifest.name);
	const moved = plan.list.filter((e) => e.manifest.name !== target && installed.has(e.manifest.name)).map((e) => `${e.manifest.name} ${installed.get(e.manifest.name).version} → ${e.manifest.version}`);
	const extra = names.filter((n) => n !== target && !installed.has(n));
	const tail = `${moved.length ? ` — members: ${moved.join(', ')}` : ''}${extra.length ? ` — with ${extra.join(', ')}` : ''}`;
	log(`▶ update: ${target} ${here.version} → ${next}${tail}`);
	const step = await npmAndCompile(ws, plan.list, { npm, open, log, what: 'update' });
	if (step.code !== undefined) return step.code;
	// the setup half in a fresh process: this one imported the version npm just replaced (ESM caches it)
	const out = setupInChild(ws.root, names, { subject, processEnv, noCommit });
	if (!out) {
		console.error(`✖ ${target} ${here.version} → ${next}: npm and compile ran, but the setup half did not finish — run dt install ${target} to finish it (it commits the re-pin and runs the setup)`);
		return EXIT.failed;
	}
	log(`✔ ${target} ${here.version} → ${next}${tail} — compiled${out.committed ? `, committed (${out.committed.join(', ')})` : ', not committed'}`);
	printUnitResults(out.results, out.ignored, log);
	return out.code;
}

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'update-setup.js');
/** Run setupAndCommit in src/update-setup.js; its result, or null when the child did not leave one. */
function setupInChild(root, names, { subject, processEnv, noCommit }) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-update-'));
	const out = path.join(dir, 'result.json');
	try {
		const r = spawnSync(process.execPath, [CHILD, JSON.stringify({ root, names, subject, noCommit, out })], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'], env: processEnv });
		if (r.status !== 0) return null;
		try { return JSON.parse(fs.readFileSync(out, 'utf8')); } catch { return null; }
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** The `dt update` argv: a target (`name`, `name@version`), `--engine`, `--allow downgrade`, `--from <dir>`, `--no-commit`. */
export function parseUpdateArgs(argv) {
	const out = { name: null, version: null, engine: argv.includes('--engine'), allow: new Set(), from: null, noCommit: argv.includes('--no-commit') };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--allow') { const k = argv[++i]; if (k !== 'downgrade') throw new Error(`dt update --allow takes downgrade (got ${JSON.stringify(k)})`); out.allow.add(k); }
		else if (a === '--from') out.from = argv[++i] ?? null;
		else if (!a.startsWith('--') && !['--allow', '--from'].includes(argv[i - 1])) {
			const at = a.startsWith('@') ? a.indexOf('@', 1) : a.indexOf('@');
			if (at > 0) { out.name = a.slice(0, at); out.version = a.slice(at + 1); } else out.name = a;
		}
	}
	return out;
}
