// Engine extensions — the ONE seam an optional tool plugs into.
//
// Core is records + the workspace compiler, and nothing that has a lifecycle of its own: an HTTP
// server, a Docker host, a behaviour-test runner, an exporter to one vendor. Those ship as sibling
// packages, and a workspace opts into one by DEPENDING on it — a direct dependency whose package.json
// declares `"dreamteamer": { "extension": "./entry.js" }`. That is the whole declaration: npm already
// put the code there on purpose, and a transitive package is never loaded however it advertises.
//
// The entry's default export is `activate(dt)` — `dt` is the RUNNING engine's public API (api.js), so
// an extension never imports a second engine copy of its own and can never disagree with the one the
// operator ran (the dev-clone shadow and `--vault` both pick the engine before this file loads).
// A workspace's own `modules/<id>/` may declare the same key: its code is the operator's, so it
// loads without a package — the way a workspace carries an extension nobody has published.
// It returns a contribution, every key optional:
//
//   commands    { <verb>: { usage, run(ws, argv) } }       `dt <verb> …`, dispatched in-process
//   sourceKinds [{ kind, exclude?: [subtree] }]             folders compile stages like a built-in kind
//   analyze     (draft) → { errors?, warnings?, notes? }    judged after assembly, before any output
//   harnesses   { <id>: (ctx) → { blocks: {file: text}, summary } }   a harness adapter
//   orientation string                                      one paragraph appended to the orientation block
//   hooks       { <ClaudeHookEvent>: '<dt verb args>' }     rendered by `dt install --print-adapters`
//   check       ({ root, ws, dt }) → [{ file, message }]   cross-record rules `dt check` reports after the schema's
//   doctor      ({ root, ws, dt }) → [{ label, state, detail?, fix? }]   rows `dt doctor` renders as one capability
//
// Two contributions claiming the same verb, kind or harness is a refusal — there is no "last one
// wins", because the loser would be an extension the operator installed that silently does nothing.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { satisfies } from './semver.js';
import { engineVersion } from './runtime.js';

export const EXTENSION_API = 1;

const CONTRIBUTION_KEYS = new Set(['commands', 'sourceKinds', 'analyze', 'harnesses', 'orientation', 'hooks', 'check', 'doctor']);

/** The modules that declare an extension entry: the workspace's own `modules/<id>/` first, then each
 *  clone under `git_modules/` (the clone's root, then the modules it bundles under `modules/`), then its
 *  direct dependencies, each sorted by name — the three channels module content arrives through. A workspace module is the operator's own code, exactly
 *  like its `bin/`, so it needs no package and no npm — and it SHADOWS a dependency of the same name,
 *  the rule module content already follows. A module DISABLED by a bare `dreamteamer.disable` entry
 *  is not an extension either — disabling is how a workspace keeps a module and switches it off. */
export function declaredExtensions(ws) {
	const disable = ws.pkg?.dreamteamer?.disable ?? [];
	const out = [];
	const seen = new Set();
	const consider = (dir, fallback) => {
		let pkg;
		try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return; }
		const entry = pkg.dreamteamer?.extension;
		const name = pkg.name ?? fallback;
		if (!entry || seen.has(name) || disablesPackage(disable, name)) return;
		if (typeof entry !== 'string') throw new Error(`${name}: dreamteamer.extension must be a path to the entry module (got ${JSON.stringify(entry)})`);
		seen.add(name);
		// a module whose engine floor is unmet is refused whole, its code with its content
		const range = pkg.dreamteamer.engine;
		if (range && satisfies(engineVersion(), range) === false) return void console.warn(`✖ extension ${name} needs engine "${range}" — this is ${engineVersion()}, so it is not loaded`);
		out.push({ name, version: pkg.version ?? '0.0.0', dir, entry: path.join(dir, entry) });
	};
	let inline = [];
	try { inline = fs.readdirSync(path.join(ws.root, 'modules')).sort(); } catch { /* no modules/ */ }
	for (const id of inline) consider(path.join(ws.root, 'modules', id), id);
	const listed = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return []; } };
	for (const clone of listed(path.join(ws.root, 'git_modules'))) {
		const root = path.join(ws.root, 'git_modules', clone);
		let rootName = clone;
		try { rootName = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name ?? clone; } catch { /* no manifest */ }
		if (disablesPackage(disable, rootName)) continue; // a disabled bundle takes its children with it
		consider(root, clone);
		for (const id of listed(path.join(root, 'modules'))) consider(path.join(root, 'modules', id), id);
	}
	for (const dep of Object.keys({ ...ws.pkg?.dependencies, ...ws.pkg?.devDependencies }).sort()) consider(path.join(ws.root, 'node_modules', dep), dep);
	return out;
}

/**
 * Does a `dreamteamer.disable` list switch off the WHOLE package `name`? An entry names a package by
 * its full name (`@scope/kit`, `probe-kit`) or by its module id — the name with the npm
 * scope stripped (`kit`), which is what every engine message calls a module. Anything else with
 * a slash is `<module>/<entity>`, one entity of a module, and never the package.
 *
 * ⚠ The scoped full name used to be read as `<module>/<entity>` because it contains a slash, and the
 * bare id was compared against the full name — so neither spelling could disable a scoped package.
 * Every extension this project ships is scoped.
 */
export function disablesPackage(disable, name) {
	const id = String(name).replace(/^@[^/]+\//, '');
	return (disable ?? []).some((d) => typeof d === 'string' && (d === name || d === id));
}

/** Is a `dreamteamer.disable` entry a whole-package name rather than `<module>/<entity>`? A bare
 *  word, or a scoped npm name (`@scope/name` — one slash, leading `@`). */
export const isPackageEntry = (d) => typeof d === 'string' && (!d.includes('/') || /^@[^/]+\/[^/]+$/.test(d));

/**
 * Import and activate every declared extension against `api`, and check the contributions cannot
 * collide with core or with each other. `reserved` is what core already owns: its verbs, kinds and
 * harness ids.
 */
export async function loadExtensions(ws, api, reserved = {}) {
	const loaded = [];
	const owner = { command: new Map(), kind: new Map(), harness: new Map() };
	for (const r of reserved.verbs ?? []) owner.command.set(r, 'the engine');
	for (const r of reserved.kinds ?? []) owner.kind.set(r, 'the engine');
	for (const r of reserved.harnesses ?? []) owner.harness.set(r, 'the engine');
	const claim = (what, key, by) => {
		const prev = owner[what].get(key);
		if (prev) throw new Error(`extension ${by} contributes the ${what} "${key}", which ${prev} already owns — uninstall one, or switch it off: add "${by}" to dreamteamer.disable in package.json`);
		owner[what].set(key, by);
	};
	for (const ext of declaredExtensions(ws)) {
		let mod;
		try { mod = await import(pathToFileURL(ext.entry).href); } catch (e) {
			throw new Error(`extension ${ext.name}: its entry ${path.relative(ws.root, ext.entry)} did not load — ${e.message.split('\n')[0]} (npm install?)`);
		}
		if (typeof mod.default !== 'function') throw new Error(`extension ${ext.name}: ${path.relative(ws.root, ext.entry)} must default-export activate(dt)`);
		if (mod.apiVersion !== undefined && mod.apiVersion !== EXTENSION_API) {
			throw new Error(`extension ${ext.name} targets extension API ${mod.apiVersion}; this engine (${api.engineVersion?.() ?? '?'}) speaks ${EXTENSION_API}`);
		}
		const c = (await mod.default(api)) ?? {};
		for (const k of Object.keys(c)) if (!CONTRIBUTION_KEYS.has(k)) throw new Error(`extension ${ext.name} contributes an unknown key "${k}" — known: ${[...CONTRIBUTION_KEYS].join(', ')}`);
		const commands = c.commands ?? {};
		for (const [verb, cmd] of Object.entries(commands)) {
			if (typeof cmd?.run !== 'function') throw new Error(`extension ${ext.name}: command "${verb}" has no run(ws, argv)`);
			claim('command', verb, ext.name);
		}
		const sourceKinds = (c.sourceKinds ?? []).map((k) => normalizeKind(ext.name, k));
		for (const k of sourceKinds) claim('kind', k.kind, ext.name);
		for (const id of Object.keys(c.harnesses ?? {})) claim('harness', id, ext.name);
		for (const fn of ['analyze', 'check', 'doctor']) if (c[fn] !== undefined && typeof c[fn] !== 'function') throw new Error(`extension ${ext.name}: ${fn} must be a function`);
		loaded.push({ name: ext.name, version: ext.version, commands, sourceKinds, analyze: c.analyze ?? null, harnesses: c.harnesses ?? {}, orientation: c.orientation ?? null, hooks: c.hooks ?? {}, check: c.check ?? null, doctor: c.doctor ?? null });
	}
	return loaded;
}

/** A contributed source kind: a plain folder name, and excluded subtrees that stay RELATIVE to it. */
function normalizeKind(by, k) {
	const kind = typeof k === 'string' ? k : k?.kind;
	if (typeof kind !== 'string' || !/^[a-z][a-z0-9-]*$/.test(kind)) throw new Error(`extension ${by}: a source kind is a lowercase folder name (got ${JSON.stringify(kind)})`);
	const exclude = (typeof k === 'object' ? k.exclude ?? [] : []).map((e) => {
		const rel = path.posix.normalize(String(e)).replace(/\/+$/, '');
		if (!rel || rel === '.' || rel.startsWith('..') || path.posix.isAbsolute(rel)) throw new Error(`extension ${by}: kind "${kind}" excludes "${e}", which is not a subtree of it`);
		return rel;
	});
	return { kind, exclude, extension: by };
}

/** Is `relFromKind` (a '/'-separated path under the kind folder) inside one of its excluded subtrees? */
export function excludedFromKind(kinds, kind, relFromKind) {
	const k = kinds.find((x) => x.kind === kind);
	return !!k && k.exclude.some((e) => relFromKind === e || relFromKind.startsWith(`${e}/`));
}
