// dreamteamer compile — materialize (modules × workspace sources) into .dreamteamer,
// the single runtime read surface: copies + provenance manifest, then harness adapters.
// explicit only; nothing rebuilds implicitly.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { load, dump } from './yaml.js';
import { slug } from './template.js';
import { walk } from './records.js';
import { placedRecords } from './placement.js';
import { viewErrors, viewDisplay, bindingErrors } from './views.js';
import {
	normalizeNamespaces, namespaceProblems, unqualifiedProblems, defaultStoragePath, storageOverlaps,
	baseNameOf, singular, namespaceOf } from './namespace.js';
// circular on paper in earlier versions — safe: both sides only
// call at run time, same pattern as store.js ↔ compile.js.
import { runHarnessAdapters, renderContributions, BEGIN, END, INSTRUCTIONS_BEGIN, INSTRUCTIONS_END } from './harnesses.js';
import { ensureEditorRecommendation, ensureEnvExample, ensureGitignored } from './workspace.js';
import { satisfies } from './semver.js';
import { parseEnvValues } from './env-vars.js';
import { DERIVED_KINDS, readManifest, runtimeDir, engineId, engineVersion, loadDescriptors as loadCompiledDescriptors } from './runtime.js';
import { excludedFromKind, disablesPackage, isPackageEntry } from './extensions.js';
import { compileCollections, v1Refusal, CONVERTER } from './compile-collections.js';
import { storageOf, fieldsOf, displayOf, targetsOf } from './descriptor.js';
export { engineId, engineVersion, readManifest };

/**
 * Identifier → display label: `finance-accounts` → "Finance Accounts".
 *
 * The ONE derivation of a label from an id. compile resolves it INTO the descriptor so that no
 * surface re-implements it — the same lesson as `storage.base`, which lived as a re-derived path
 * test in five places before it became a field. An authored `title` always wins over this.
 *
 * `/` is a separator because a collection id may contain one (`titles.ts` splits routes on that
 * assumption). Field names cannot, which is why the extension's browser-side copy of this rule
 * (`webview/src/lib/format-title.ts`, which cannot import node code) stays byte-compatible for the
 * only comparison that matters — the round-trip guard in schema-ops.js.
 */
export function titleCase(id) {
	return String(id)
		.split(/[_\-\s/]+/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ');
}










/** The source kinds the compiler itself stages. An installed extension may add more
 *  (`sourceKinds`, src/extensions.js) — every enumeration below reads `kindsOf(ws)`, never this alone. */
/** The keys a package.json `dreamteamer` block may carry — the workspace's and a module's alike. */
export const MANIFEST_KEYS = ['title', 'description', 'workspace_module', 'data_path', 'namespaces', 'vars', 'env', 'auto_commit', 'harnesses', 'git_modules', 'disable', 'local_assets', 'postinstall', 'gitignore_runtime_folder', 'repos_path', 'dependencies', 'peer_collections', 'owns_data', 'engine', 'extension', 'ignore'];

export const KINDS = ['collections', 'skills', 'agents', 'commands', 'command-bindings', 'ui-views', 'mixins'];
const FOLDER_KINDS = new Set(['skills']); // folder-shape entities: copy the whole record folder

/** Every contributed kind of the workspace's loaded extensions, as `{ kind, exclude, extension }`. */
export const contributedKinds = (ws) => (ws.extensions ?? []).flatMap((e) => e.sourceKinds ?? []);
/** Built-in kinds, then contributed ones. */
export const kindsOf = (ws) => [...KINDS, ...contributedKinds(ws).map((k) => k.kind)];
// DERIVED_KINDS (projected, not staged) lives in runtime.js — the boundary both halves read. Not in
// KINDS on purpose: a module folder named `modules/` would be nonsense, and `isSystem` below keys
// off KINDS to decide `storage.base`, so a `modules` collection landing on `base: workspace` would
// point the store at the SOURCE directory and read every module folder as a record.

/**
 * A module's source folder for one kind. The layout is FLAT — `<module>/skills`, beside `data/` —
 * because KINDS is already the allowlist and the extra `system/` level named nothing the engine
 * reads. `<module>/system/<kind>` is still accepted so a module can be moved independently of the
 * engine that reads it (they are separate repos on separate pins).
 *
 * Returns the FLAT path when neither exists, so a caller that creates the folder creates it in the
 * layout we want. `bothLayouts` reports the split case, which compile warns about — a module with
 * half its sources in each place compiles the flat half and silently drops the rest otherwise.
 */
export function kindDir(root, kind) {
	const flat = path.join(root, kind);
	if (fs.existsSync(flat)) return flat;
	const nested = path.join(root, 'system', kind);
	return fs.existsSync(nested) ? nested : flat;
}

function bothLayouts(root, kind) {
	return fs.existsSync(path.join(root, kind)) && fs.existsSync(path.join(root, 'system', kind));
}

/**
 * Folders a module may hold that are not sources. With kinds at the module root, "not a kind" can no
 * longer mean "ignore it" — that is precisely how a kind the engine stopped knowing (`workflows`,
 * removed 2026-07-31) sat in a module for two days while compile reported ✔ and a README described a
 * pipeline nothing read (decision 156).
 *
 * So the root is ENUMERATED and an unrecognised folder is an ERROR. This list covers what a package
 * generically contains; anything else the module declares in its own package.json
 * (`dreamteamer.ignore`). That is real per-module variance — `services` has `dashboard/`, `agentlog`
 * has `data/` — not a layout knob every module would set identically.
 */
/** `bin/*` files of a module root, module-relative and sorted — dotfiles and subfolders (lib/,
 *  parsers/) excluded. Empty when there is no bin/. */
function binEntries(moduleRoot) {
	const dir = path.join(moduleRoot, 'bin');
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isFile() && !e.name.startsWith('.'))
		.map((e) => `bin/${e.name}`).sort();
}

const NON_SOURCE_DIRS = new Set([
	'node_modules', 'data', 'state', 'media', 'bin', 'src', 'lib', 'scripts',
	'ui', 'studio', // the module's UI bundle — 'studio' is the pre-archive name, kept as a fallback
	'docs', 'dist', 'build', 'test', 'tests', 'coverage', 'system', // 'system': the pre-flatten layout
]);

/** Unrecognised source-root folders in a module, or [] for the workspace root (a vault legitimately
 *  holds arbitrary directories — this gate is about PACKAGES, whose folders all mean something).
 *
 *  ⚠ `system/` is enumerated TOO, under the same rule. It is in NON_SOURCE_DIRS so the root pass
 *  waves it through, and that waved through everything BELOW it — so `system/gizmos/probe.gizmo.yaml`
 *  compiled ✔ in silence while the identical folder at the module root hard-errored. That is exactly
 *  the decision-156 shape the root gate exists to prevent, surviving one level down: `kindDir` still
 *  reads `system/<kind>` as the pre-flatten fallback, so a kind the engine stopped knowing is just as
 *  invisible there as it ever was at the root, and the half-migrated module is the likeliest place
 *  for one to be. Known kinds under `system/` keep compiling — the fallback is deliberate and stays
 *  (CLAUDE.md); only UNKNOWN folders become errors, and `dreamteamer.ignore` excuses them in both
 *  places with one entry. */
function strayKindDirs(source, wsRoot, declaredIgnore, kinds) {
	if (path.resolve(source.root) === path.resolve(wsRoot)) return [];
	const allow = new Set([...kinds, ...NON_SOURCE_DIRS, ...declaredIgnore]);
	const dirsIn = (dir, prefix = '') => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [])
		.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !allow.has(e.name))
		.map((e) => `${prefix}${e.name}`);
	return [
		...dirsIn(source.root),
		// The SAME allow set one level down — a generic package folder reads the same wherever the
		// module put it, and one `ignore` entry covers both spellings rather than two.
		...dirsIn(path.join(source.root, 'system'), 'system/'),
	].sort();
}

const sha256 = (buf) => 'sha256:' + createHash('sha256').update(buf).digest('hex');


// channel -> the directory the operator knows it by (used in shadow warnings, and it IS the
// `location` field's vocabulary — see collections/modules.collection.yaml. Keeping the export name
// on purpose: renaming a symbol under src/ is a cross-repo change, and this one buys nothing.)
export const CHANNEL_LABEL = { inline: 'modules', git: 'git_modules', npm: 'node_modules' };

/** A module's `location` — the folder its sources sit in. `root` is the classic layout, where the
 *  workspace's own sources are at its root rather than under `modules/<id>/`; discovery reports that
 *  as the `inline` channel with `root === '.'`, which is the one case the label table cannot see. */
export const locationOf = (source, wsRoot) =>
	(path.resolve(source.root) === path.resolve(wsRoot) ? 'root' : (CHANNEL_LABEL[source.channel] ?? source.channel));

// module discovery, three channels in precedence order: inline modules/* >
// git_modules/* > npm deps (declared in package.json, NOT a node_modules scan).
// same NAME in two channels = the same module delivered twice — the more local
// copy wins (npm-link semantics); shadows are returned for warning/status, never
// compiled. different-name identity collisions stay hard errors downstream.
export function discoverModules(root, pkg) {
	const byName = new Map(); // name -> {name, root, channel}
	const shadows = []; // {name, winner, loser} — channels
	// A BARE `dreamteamer.disable` entry names a whole module; `<module>/<entity>` names one entity and
	// is applied per source at compile time. The bare form is what lets a workspace take a PACKAGE of
	// modules and keep only the ones it wants — a disabled module is simply never discovered, so every
	// caller (compile, status, install) sees the same set.
	const disable = pkg?.dreamteamer?.disable ?? [];
	const disabledHits = new Set();
	// the same rule the extension loader applies (full package name, or its scope-stripped id), so a
	// disabled package loses its content AND its code together
	const disabled = (name) => {
		const hit = disable.find((d) => isPackageEntry(d) && disablesPackage([d], name));
		if (hit) disabledHits.add(hit);
		return !!hit;
	};
	const tryAdd = (name, srcRoot, channel) => {
		if (disabled(name)) return;
		const existing = byName.get(name);
		if (existing) { shadows.push({ name, winner: existing.channel, loser: channel }); return; }
		byName.set(name, { name, root: srcRoot, channel });
	};
	const readPkg = (dir) => {
		try {
			const mpkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
			return 'dreamteamer' in mpkg ? mpkg : null;
		} catch { return null; } // no package.json, or unparseable — not a module
	};
	// A PACKAGE OF MODULES: a dependency or a git clone whose root carries `modules/` bundles several
	// modules — its sub-modules are the modules, and the root itself is never compiled. One
	// `npm install` (or one clone) then delivers a whole family, and `disable` cherry-picks from it.
	// Inline `modules/*` never nest: a `modules/` folder at an inline module root stays the
	// unknown-folder compile error it always was, because the workspace's own tree has no reason to
	// bundle.
	const scanDir = (dir, channel, unpack) => {
		if (!fs.existsSync(dir)) return;
		for (const name of fs.readdirSync(dir).sort()) {
			const srcRoot = path.join(dir, name);
			const mpkg = readPkg(srcRoot);
			if (mpkg) (unpack ? tryAddOrUnpack : tryAdd)(mpkg.name ?? name, srcRoot, channel);
		}
	};
	const tryAddOrUnpack = (name, srcRoot, channel) => {
		// ⚠ THE PACKAGE FIRST: disabling a bundle disables every module in it. Only the children used to
		// be checked, so `disable: ['@x/bundle']` stopped its code and compiled all of its content.
		if (disabled(name)) return;
		const bundle = path.join(srcRoot, 'modules');
		if (fs.existsSync(bundle) && fs.statSync(bundle).isDirectory()) { scanDir(bundle, channel, false); return; }
		tryAdd(name, srcRoot, channel);
	};
	scanDir(path.join(root, 'modules'), 'inline', false);
	scanDir(path.join(root, 'git_modules'), 'git', true);
	for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).sort()) {
		const srcRoot = path.join(root, 'node_modules', dep);
		const mpkg = readPkg(srcRoot);
		if (mpkg) tryAddOrUnpack(mpkg.name ?? dep, srcRoot, 'npm');
	}
	return { modules: [...byName.values()], shadows, disabledModules: [...disabledHits] };
}

// ---- module-owned data ----------------------------------------------------------
// A module with `owns-data: true` keeps its records BESIDE ITSELF rather than in the
// workspace's data/. The descriptor still says `data/<collection>`; compile is what turns
// that into a path, so the module never names its host.

/** modules that own their data, by module name → {root, channel}. Validates the flag and the
 *  channel: records that could never be committed are a compile ERROR, not a silent zero. */
function dataOwningModules(sources, fail, rel) {
	const owners = new Map();
	for (const s of sources) {
		let mpkg;
		try { mpkg = JSON.parse(fs.readFileSync(path.join(s.root, 'package.json'), 'utf8')); } catch { continue; }
		const flag = mpkg.dreamteamer?.owns_data;
		if (flag === undefined || flag === false) continue;
		if (flag !== true) fail(`module "${s.name}": "owns_data" must be true or false (got ${JSON.stringify(flag)})`);
		// Decided from the CHANNEL, never by asking git — compile shells out to git nowhere and
		// must keep working in a freshly-`init`ed directory that is not a repo yet.
		if (s.channel === 'npm') {
			fail(`module "${s.name}" sets owns_data, but it is installed under node_modules/ — that path is never committed, so its records could not be saved. Vendor it into modules/ or install it as a git module.`);
		}
		if (s.channel === 'git' && !fs.existsSync(path.join(s.root, '.git'))) {
			fail(`module "${s.name}" sets owns_data, but ${rel(s.root)} is not a git clone — git_modules/ is gitignored by the workspace, so its records could never be committed.`);
		}
		owners.set(s.name, { root: s.root, channel: s.channel });
	}
	return owners;
}

/** The git repo that will hold a module's records: nearest `.git` at or above the module root,
 *  as a workspace-relative path (`.` = the workspace itself). `.git` may be a FILE — worktrees
 *  and submodules write a pointer file rather than a directory — so existsSync, not isDirectory. */
export function repoRootOf(moduleRoot, wsRoot) {
	const stop = path.resolve(wsRoot);
	let dir = path.resolve(moduleRoot);
	while (dir.startsWith(stop)) {
		if (fs.existsSync(path.join(dir, '.git'))) return path.relative(stop, dir) || '.';
		if (dir === stop) break;
		dir = path.dirname(dir);
	}
	return '.';
}

export function shadowWarning({ name, winner, loser }) {
	return `⚠ module ${name}: ${CHANNEL_LABEL[winner]} copy shadows ${CHANNEL_LABEL[loser]} copy`;
}

export function compile(ws) {
	const { root, pkg } = ws;
	const extensions = ws.extensions ?? [];
	const contributed = contributedKinds(ws);
	const kinds = kindsOf(ws);
	const RUNTIME = runtimeDir(root);
	// read BEFORE anything below replaces the runtime: an extension's analysis compares against it,
	// and the harness pass prunes what it listed
	const prevManifest = readManifest(root);
	const config = pkg.dreamteamer ?? {};
	const harnesses = config.harnesses ?? ['claude-code'];
	const rel = (p) => path.relative(root, p);

	/** ⚠ YAML, WITH THE FILE IN THE MESSAGE. js-yaml reports `line:column` and a snippet and never a
	 *  path, so one stray tab in a workspace of a hundred sources was an mtime bisect. Every parse of
	 *  a MODULE SOURCE goes through here; the projected records compile dumps itself do not need it. */
	const loadSource = (text, srcPath) => {
		try {
			return load(text);
		} catch (e) {
			return fail(`${srcPath}: ${e.message}`);
		}
	};

	/** An EMPTY source is never intentional, and every reader indexes straight into what it parses.
	 *  The collection case died with a bare "Cannot read properties of undefined" naming no file; a
	 *  0-byte ui-view was worse — compile said ✔ and `check` caught it one gate later, naming the
	 *  COMPILED artifact under `.dreamteamer/`, which nobody can edit and the next compile overwrites.
	 *  Refuse here, the last layer that still knows which module file the bytes came from.
	 *  ⚠ ENTITY FILES ONLY. A skill is a FOLDER: its `SKILL.md` is the entity and is covered, while a
	 *  placeholder under `references/` is the author's business, not the compiler's. */
	const refuseEmptySource = (srcPath) => {
		if (fs.readFileSync(srcPath, 'utf8').trim() === '') {
			fail(`${rel(srcPath)}: source is empty — there is nothing to compile. Delete the file, or write one.`);
		}
	};

	// ---- discover sources: channel modules then the workspace's own -----------------
	const { modules: discovered, shadows, disabledModules } = discoverModules(root, pkg);
	for (const s of shadows) console.warn(shadowWarning(s));
	const sources = [...discovered];
	// workspace-owned sources: either at the root (classic layout) or in the designated
	// workspace module under modules/ (config `workspace-module` — "the workspace is itself a
	// module", made literal). when the key is set the root is NOT read, so the two layouts can
	// never fork — and a stray source folder up there is a loud error rather than a silent drop.
	if (!config.workspace_module) {
		sources.push({ name: pkg.name, root, channel: 'inline' });
	} else {
		const strays = [];
		if (fs.existsSync(path.join(root, 'system')) && [...walk(path.join(root, 'system'))].length) strays.push('system/');
		for (const kind of kinds) {
			const dir = path.join(root, kind);
			if (fs.existsSync(dir) && [...walk(dir)].length) strays.push(`${kind}/`);
		}
		if (strays.length) {
			fail(`the workspace root contains sources (${strays.join(', ')}) but workspace_module="${config.workspace_module}" is set — they would be silently ignored.\n  move them into modules/${config.workspace_module}/ (decision 22).`);
		}
	}

	// ---- engine floors: a module whose `dreamteamer.engine` excludes this engine is REFUSED whole —
	// none of its content compiles, since it may use what this engine cannot read; the rest does
	const engineVer = engineVersion();
	const refused = new Map(); // module name -> the range it declares
	for (const source of [...sources]) {
		if (source.root === root) continue;
		let range;
		try { range = JSON.parse(fs.readFileSync(path.join(source.root, 'package.json'), 'utf8')).dreamteamer?.engine; } catch { continue; }
		if (!range || satisfies(engineVer, range) !== false) continue;
		refused.set(source.name, range);
		sources.splice(sources.indexOf(source), 1);
		console.warn(`✖ module ${source.name} needs engine "${range}" — this is ${engineVer}, so none of its content is compiled. Upgrade dreamteamer, or disable the module.`);
	}

	// ---- module package pass: env declarations; a missing secret warns, never fails ---------
	// A module's record id: the npm scope stripped, so `@dreamteamer/crm` reads as `crm` — which is
	// what every message in this engine already calls it. Defined HERE, above the namespace pass,
	// because a namespace error has to name the module by the id the fix is typed with.
	const moduleId = (n) => slug(String(n).replace(/^@[^/]+\//, ''));
	const channelOf = new Map(sources.map((s) => [s.name, s.channel]));
	const declaredEnv = new Map(); // env key -> [module names]
	const requestedVars = new Map(); // var a module READS through ${env:…} -> [module names]
	const envMeta = new Map();     // env key or var -> { description, example } — the first module to say wins
	const moduleIgnores = new Map(); // module name -> non-source folders it declares (strayKindDirs)
	const moduleDeps = new Map();  // module name -> [module names]      — HARD, must be acyclic
	const modulePeers = new Map(); // module name -> [collection names]  — SOFT, cannot cycle
	const moduleNamespaces = new Map(); // module name -> [namespaces it DECLARES] (§8, option A)
	const moduleLocalAssets = []; // {rel, owner, base} — validated with the workspace's own, below
	// the package.json `dreamteamer` block is a closed set of snake_case keys, the workspace's and
	// every module's alike — a key outside it is a typo or a spelling this engine does not read
	const refuseUnknownKeys = (block, where) => {
		const bad = Object.keys(block ?? {}).filter((k) => !MANIFEST_KEYS.includes(k));
		// a kebab-case spelling of a key this engine reads is the v1 manifest: the converter rewrites it
		const v1 = bad.filter((k) => k === 'peerDependencies' || MANIFEST_KEYS.includes(k.replace(/-/g, '_')));
		if (v1.length) fail(`${where}: the dreamteamer block is in the v1 spelling (${v1.join(', ')}).\n  convert the workspace once: ${CONVERTER}\n  then dt compile and dt check — UPDATING.md has the walk.`);
		if (bad.length) fail(`${where}: unknown dreamteamer key(s) ${bad.join(', ')} — the keys are ${MANIFEST_KEYS.join(' · ')}`);
	};
	refuseUnknownKeys(config, 'package.json');
	for (const source of sources) {
		let mpkg;
		try { mpkg = JSON.parse(fs.readFileSync(path.join(source.root, 'package.json'), 'utf8')); } catch { continue; }
		if (source.root !== root && mpkg.dreamteamer) refuseUnknownKeys(mpkg.dreamteamer, rel(path.join(source.root, 'package.json')));
		const ignore = mpkg.dreamteamer?.ignore;
		if (ignore !== undefined) {
			if (!Array.isArray(ignore)) fail(`module "${source.name}": "ignore" must be a list of folder names (got ${JSON.stringify(ignore)})`);
			moduleIgnores.set(source.name, ignore.map(String));
		}
		// npm's TERMINOLOGY, deliberately not npm's namespace: these live under `dreamteamer` so
		// npm's own resolver never tries to fetch an inline or git-channel module.
		for (const [key, sink] of [['dependencies', moduleDeps], ['peer_collections', modulePeers]]) {
			const decl = mpkg.dreamteamer?.[key];
			if (decl === undefined) continue;
			if (!Array.isArray(decl) || decl.some((v) => typeof v !== 'string')) {
				fail(`module "${source.name}": dreamteamer.${key} must be a list of ${key === 'dependencies' ? 'module names' : 'collection names'} (got ${JSON.stringify(decl)})`);
			}
			sink.set(source.name, decl);
		}
		// §8: A MODULE DECLARES THE NAMESPACES IT OWNS. Reversed from "the workspace only, never a
		// module", whose real reason (a module could rename where another module's records live) is
		// kept by the single-owner rule and the use-requires-dependency rule below — while the rule it
		// replaces made decision 130's own acceptance test unpassable for any namespaced module.
		const ns = mpkg.dreamteamer?.namespaces;
		if (ns !== undefined) {
			if (!Array.isArray(ns) || ns.some((v) => typeof v !== 'string')) {
				fail(`module "${source.name}": dreamteamer.namespaces must be a list of namespace names (got ${JSON.stringify(ns)})`);
			}
			moduleNamespaces.set(source.name, ns);
		}
		const range = mpkg.dreamteamer?.engine;
		if (range && satisfies(engineVer, range) === null) console.warn(`⚠ module ${source.name}: engine range "${range}" not understood by the built-in checker (see src/semver.js) — not verified`);
		// `dreamteamer.env` (keys the module needs) and, in a module, `dreamteamer.vars` (the
		// `${env:…}` vars it reads): each entry a bare name or `{ name, description, example }`, so
		// `.env.example` says what a value looks like. A module only REQUESTS a var — the workspace's
		// own list is the allow-list, so a module can never add a key to what `dt resolve` renders.
		for (const key of source.root === root ? ['env'] : ['env', 'vars']) {
			const decl = mpkg.dreamteamer?.[key] ?? [];
			const sink = key === 'env' ? declaredEnv : requestedVars;
			if (!Array.isArray(decl)) fail(`module "${source.name}": dreamteamer.${key} must be a list of key names or { name, description, example } objects (got ${JSON.stringify(decl)})`);
			for (const entry of decl) {
				const k = typeof entry === 'string' ? entry : entry?.name;
				if (typeof k !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) fail(`module "${source.name}": dreamteamer.${key} entry ${JSON.stringify(entry)} — a key is an identifier (A-Z, 0-9, _) as a string or as { name, description, example }`);
				if (!sink.has(k)) sink.set(k, []);
				sink.get(k).push(source.name);
				if (typeof entry === 'object' && !envMeta.has(k)) envMeta.set(k, { description: entry.description ? String(entry.description) : undefined, example: entry.example !== undefined ? String(entry.example) : undefined });
			}
		}
		// Gathered here because mpkg is already parsed; refused below, next to the workspace's own
		// declaration. The classic layout pushes the ROOT itself as an inline source, whose
		// package.json IS `config` — reading it here too would report every workspace-level
		// declaration twice, under the wrong owner.
		if (source.root !== root) {
			for (const rel of mpkg.dreamteamer?.local_assets ?? []) moduleLocalAssets.push({ rel, owner: source.name, base: source.root });
		}
	}
	// `dreamteamer.vars` is the WORKSPACE's own declaration (root package.json, not a module's): the
	// keys a `${env:NAME}` template is allowed to name. Same missing-key question as
	// `dreamteamer.env`, one .env parse, two warnings — a module needs its key to RUN, a var is
	// needed the moment someone calls `dt resolve`, and only the workspace can declare one.
	if (config.vars !== undefined && (!Array.isArray(config.vars) || config.vars.some((v) => typeof v !== 'string'))) {
		fail(`dreamteamer.vars must be a list of env key names (got ${JSON.stringify(config.vars)})`);
	}
	const declaredVars = config.vars ?? [];
	for (const [k, mods] of requestedVars) {
		if (!declaredVars.includes(k)) for (const mod of mods) console.warn(`⚠ module ${mod} reads \${env:${k}} — add it to the workspace's dreamteamer.vars`);
	}
	if (declaredEnv.size || declaredVars.length) {
		// .env is parsed for KEY names ONLY — values never reach any output or the manifest
		const envPath = path.join(root, '.env');
		if (!fs.existsSync(envPath)) {
			if (declaredEnv.size) console.warn(`⚠ no .env — modules declare env keys: ${[...declaredEnv.keys()].join(', ')} (see .env.example)`);
			if (declaredVars.length) console.warn(`⚠ no .env — dreamteamer.vars declares ${declaredVars.join(', ')}, so no \${env:…} template can render here (see .env.example)`);
		} else {
			// ⚠ THE ONE PARSER, not a key regex of our own. This used to hand-roll
			// `/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/`, which accepted two lines
			// `parseEnvValues` deliberately drops (`KEY =value`, and an indented key) and scanned a
			// quoted value's continuation lines for keys. Either disagreement produces the worst
			// pairing there is: compile says nothing and then `dt resolve` answers "no value in
			// .env" about a line the operator is looking straight at. Values are read here and
			// never printed — the warnings below name keys only.
			// A key present with an EMPTY (or whitespace-only) value is treated as absent, same as
			// resolve's renderTemplate — `FILES_FOLDER=` must warn here exactly as `FILES_FOLDER`
			// missing entirely would, or compile says nothing and resolve fails on the same line.
			const parsedEnv = parseEnvValues(fs.readFileSync(envPath, 'utf8'));
			const present = new Set([...parsedEnv].filter(([, v]) => v.trim() !== '').map(([k]) => k));
			for (const [k, mods] of declaredEnv) {
				if (present.has(k)) continue;
				const about = envMeta.get(k)?.description ? ` (${envMeta.get(k).description})` : '';
				for (const mod of mods) console.warn(`⚠ module ${mod} declares env key ${k}${about} — missing from .env (see .env.example)`);
			}
			for (const k of declaredVars) {
				if (present.has(k)) continue;
				console.warn(`⚠ dreamteamer.vars declares ${k} — missing from .env, so \${env:${k}} cannot render on this machine`);
			}
		}
	}

	// Two root files kept current on every compile, both cheap and both about the FIRST run of a
	// stranger: `.env.example` lists every declared key with its description, so the warning above
	// points at a file that actually names them; `.vscode/extensions.json` recommends the editor
	// extension, so the first window offers it. Both are append/merge-only — nothing authored moves.
	{
		const added = ensureEnvExample(root, [...declaredEnv, ...requestedVars].map(([key, mods]) => ({ key, modules: mods, ...(envMeta.get(key) ?? {}) })),
			'# secrets for skills and modules go here (copy to .env; .env is never committed).\n# modules declare the env keys they require in their package.json dreamteamer.env list.\n');
		if (added.length) console.log(`✔ .env.example now names ${added.join(', ')}`);
		ensureEditorRecommendation(root);
	}

	// ---- local-assets and postinstall: what `dt install` will do to a checkout -------
	// `local-assets` are the gitignored heavy folders a checkout SHARES by symlink instead of
	// duplicating — a browser profile dir, a model cache. Declared, never discovered. Every
	// refusal below is something the installer would otherwise hit at RUN time, on a machine nobody
	// is watching; the compiler is where a declaration is cheap to fix. (`src/checkout.js` refuses
	// the escaping rel a second time when the plan is built — a runtime that writes a symlink
	// outside the root must not wait for the compiler to be run.)
	const ENGINE_OWNED = new Set(['.env', 'node_modules', '.dreamteamer', '.git']);
	const gitQ = (args) => { try { execFileSync('git', args, { cwd: root, stdio: 'ignore' }); return true; } catch { return false; } };
	for (const a of [...(config.local_assets ?? []).map((rel) => ({ rel, owner: 'workspace', base: root })), ...moduleLocalAssets]) {
		const abs = path.resolve(a.base, a.rel), rel = path.relative(root, abs);
		if (a.owner !== 'workspace' && path.relative(a.base, abs).startsWith('..')) fail(`local_assets: "${a.rel}" (module ${a.owner}) escapes its module with .. — declare it at the workspace level instead`);
		// The workspace-level twin, and it earns its own line: a rel that climbs out of the ROOT
		// otherwise reached the gitignore check below, which cannot see a path outside the repo and
		// so told the operator to ignore something git will never match. `checkout.js` refuses the
		// same shape when the plan is built.
		if (rel.startsWith('..')) fail(`local_assets: "${a.rel}" escapes the workspace root with .. — a local asset must be a path INSIDE the workspace`);
		if (ENGINE_OWNED.has(rel.split(path.sep)[0])) fail(`local_assets: "${rel}" is engine-owned — install links .env and installs node_modules itself; never declare them`);
		if (gitQ(['ls-files', '--error-unmatch', rel])) fail(`local_assets: "${rel}" is tracked — a tracked path needs no link and a link would shadow it`);
		// ⚠ WITHOUT a trailing slash, and the message has to say so: a dir-only pattern (`.profiles/`)
		// matches neither a symlink nor a path that does not exist yet (measured, git 2.50) — and a
		// shared asset is exactly those two shapes, a symlink in every non-primary checkout and
		// absent before the first install.
		if (!gitQ(['check-ignore', '-q', rel])) fail(`local_assets: "${rel}" is not gitignored — add it to .gitignore WITHOUT a trailing slash (a worktree holds it as a symlink, and a dir-only pattern ignores neither a symlink nor an absent path); a shared asset must never be committed`);
	}
	if (config.postinstall != null && typeof config.postinstall !== 'string') fail('dreamteamer.postinstall must be a single shell string');

	// ---- the module dependency graph -------------------------------------------------
	// `dependencies` names MODULES and must be acyclic. `peer_collections` names COLLECTIONS and
	// therefore cannot cycle at all — which is the whole reason it exists: two modules that each
	// reference a concept the other owns (crm needs `products`, rnd needs `contacts`) would be an
	// unbreakable ring under module-named deps, and are two independent peer declarations here.
	const moduleNames = new Set(sources.map((s) => s.name));
	for (const [mod, deps] of moduleDeps) {
		for (const dep of deps) {
			if (dep === mod) fail(`module "${mod}" declares itself as a dependency`);
			if (refused.has(dep)) fail(`module "${mod}" depends on "${dep}", which needs engine "${refused.get(dep)}" — this is ${engineVer}. Upgrade dreamteamer, or disable both.`);
			if (!moduleNames.has(dep)) {
				fail(`module "${mod}" depends on "${dep}", which is not installed — modules present: ${[...moduleNames].sort().join(', ')}`);
			}
		}
	}
	// DFS with an explicit path so the error can print the ring rather than just naming one module
	{
		const state = new Map(); // name -> 'open' | 'done'
		const visit = (mod, trail) => {
			if (state.get(mod) === 'done') return;
			if (state.get(mod) === 'open') {
				const ring = [...trail.slice(trail.indexOf(mod)), mod];
				fail(`cyclic module dependencies: ${ring.join(' → ')}\n  a reference to a CONCEPT another module owns belongs in dreamteamer.peer_collections (a collection name), which cannot cycle.`);
			}
			state.set(mod, 'open');
			for (const dep of moduleDeps.get(mod) ?? []) visit(dep, [...trail, mod]);
			state.set(mod, 'done');
		};
		for (const mod of moduleDeps.keys()) visit(mod, []);
	}

	const dataOwners = dataOwningModules(sources, fail, rel);

	const disabled = new Set(config.disable ?? []);
	const disabledHits = new Set(disabledModules); // bare entries were applied at discovery

	/** entries: runtime-relative path -> { sources: [workspace-relative], bytes } */
	const entries = new Map();
	const counts = {};
	/** collection descriptors collected per name for extends-merging: name -> [{src, doc, moduleName}] */
	const descriptorGroups = new Map();

	function addEntry(runtimePath, srcPath) {
		if (entries.has(runtimePath)) {
			const [, kind, entity] = /^([^/]+)\/([^/]+)/.exec(runtimePath) ?? [];
			const entityId = (entity ?? '').replace(/\.[^.]+\.(yaml|md|json)$/, '');
			const prev = entries.get(runtimePath).sources[0].path;
			fail(`name collision on ${kind?.replace(/s$/, '') ?? 'entity'} "${entityId}"
    - ${prev}
    - ${rel(srcPath)}
  identity entities are never merged or shadowed (schemas may use 'extends').
  either rename yours, or disable one: add "<module>/${entityId}" to dreamteamer.disable in package.json.`);
		}
		const bytes = fs.readFileSync(srcPath);
		entries.set(runtimePath, { sources: [{ path: rel(srcPath), hash: sha256(bytes) }], bytes });
	}

	/** module names that actually put something into the compiled runtime — see the warning below */
	const contributedBy = new Set();

	for (const source of sources) {
		// an unrecognised folder at a module root is a typo'd kind or a kind the engine dropped —
		// both of which used to compile ✔ and contribute nothing (see NON_SOURCE_DIRS)
		const strays = strayKindDirs(source, root, moduleIgnores.get(source.name) ?? [], kinds);
		if (strays.length) {
			// `ignore` matches a FOLDER NAME, at the root and under `system/` alike, so the remedy has
			// to quote the bare name — suggesting "system/gizmos" would print an entry that matches
			// nothing and send the reader back for a second compile to find that out.
			const ignorable = [...new Set(strays.map((s) => s.replace(/^system\//, '')))];
			fail(`module "${source.name}" (${rel(source.root)}) has folder(s) that are not a known kind: ${strays.join(', ')}
  known kinds: ${kinds.join(', ')}${contributed.length ? '' : `\n  a kind an extension adds (proofs/, for one) is known only while that extension is installed or its module is present`}
  if these are not sources, declare them: "dreamteamer": { "ignore": [${ignorable.map((s) => `"${s}"`).join(', ')}] } in ${rel(path.join(source.root, 'package.json'))}`);
		}
		for (const kind of kinds) {
			// a half-moved module compiles its flat half and drops the rest — say so rather than
			// reporting ✔ over a silent partial read (the decision-156 failure shape)
			if (bothLayouts(source.root, kind)) {
				console.warn(`⚠ module ${source.name}: both ${kind}/ and system/${kind}/ exist — the flat copy wins and system/${kind}/ is NOT compiled. finish the move.`);
			}
			const srcDir = kindDir(source.root, kind);
			if (!fs.existsSync(srcDir)) continue;
			counts[kind] ??= 0;
			// `collections/` is enumerated RECURSIVELY, so a namespaced descriptor can be authored at
			// `collections/health/doctors.collection.yaml` — mirroring where it lands in the runtime and
			// letting a workspace group its descriptors the same way its data is grouped.
			//
			// ⚠ This is load-bearing, not cosmetic. `schema-ops` derives a descriptor's source path from
			// its name, so `add-field` on `health/doctors` writes the nested path; with a flat readdir
			// that file was written, silently skipped, and the verb reported ✔ while changing nothing —
			// the decision-156 shape again. Every other kind stays flat: their ids are single segments.
			const names = kind === 'collections'
				? [...walk(srcDir)].map((f) => path.relative(srcDir, f).split(path.sep).join('/'))
				: fs.readdirSync(srcDir).sort();
			for (const name of names) {
				if (name.startsWith('.')) continue;
				if (excludedFromKind(contributed, kind, name)) continue;
				const entityId = name.replace(/\.[^.]+\.(yaml|md|json)$/, '');
				// an entity entry is `<kind>/<id>` — a record reference — and names that entity in any module
				if (disabled.has(`${kind}/${entityId}`)) { disabledHits.add(`${kind}/${entityId}`); continue; }
				const srcPath = path.join(srcDir, name);
				const isDir = fs.statSync(srcPath).isDirectory();
				if (kind === 'collections' && !isDir) {
					// a base and its overlays merge — collect per collection name
					const bytes = fs.readFileSync(srcPath);
					// A `touch`ed file on the way to writing one is the ordinary way to arrive here. The
					// descriptor keeps its own wording — it is the one kind that can say what is missing.
					if (bytes.toString('utf8').trim() === '') {
						fail(`${rel(srcPath)}: collection source is empty — a descriptor needs at least 'name' and 'fields'. Delete the file, or write one.`);
					}
					const doc = loadSource(bytes.toString('utf8'), rel(srcPath));
					// a scalar or a list parses fine and then reads as undefined on every key below
					if (doc == null || typeof doc !== 'object' || Array.isArray(doc)) {
						fail(`${rel(srcPath)}: collection source is not a mapping — a descriptor needs at least 'name' and 'fields'.`);
					}
					// a v1 source is refused with every other one, in one message (compile-collections.js)
					if (!doc.name) fail(`${rel(srcPath)}: descriptor needs 'name'`);
					if (!descriptorGroups.has(doc.name)) descriptorGroups.set(doc.name, []);
					descriptorGroups.get(doc.name).push({ src: { path: rel(srcPath), hash: sha256(bytes) }, doc, moduleName: source.name });
					contributedBy.add(source.name);
				} else if (FOLDER_KINDS.has(kind) && isDir) {
					// the folder's ENTITY file, not its payload — see refuseEmptySource
					const entityFile = path.join(srcPath, 'SKILL.md');
					if (fs.existsSync(entityFile)) refuseEmptySource(entityFile);
					for (const file of walk(srcPath)) {
						addEntry(path.join(kind, name, path.relative(srcPath, file)), file);
						contributedBy.add(source.name);
					}
					counts[kind]++;
				} else if (!isDir) {
					refuseEmptySource(srcPath);
					addEntry(path.join(kind, name), srcPath);
					contributedBy.add(source.name);
					counts[kind]++;
				} else {
					// nested dirs for file-shape kinds (e.g. date-partitioned) — recurse
					for (const file of walk(srcPath)) {
						refuseEmptySource(file);
						addEntry(path.join(kind, path.relative(srcDir, file)), file);
						contributedBy.add(source.name);
						counts[kind]++;
					}
				}
			}
		}
	}

	// ---- stage module UI bundles ---------------------------------------------------
	// modules ship a PRE-BUILT app.js that registers components/layouts against the surface's
	// registry (design "the UI": components are module code, never records). staged under
	// .dreamteamer/ui/<module>/app.js; the VS Code extension reads it off disk (decision 48) and
	// the legacy server served it at /ui. `dist/app.js` (a built bundle) wins over `app.js`
	// (plain-JS, host-provided Vue).
	//
	// `ui/` is the name — it matches where the bundle STAGES and what it is. `studio/` is the
	// original name and stays a fallback: the studio it referred to is archived (decisions 51, 93),
	// so the folder was named after a surface that no longer exists. Both are in NON_SOURCE_DIRS,
	// so neither trips the unknown-folder gate (decision 179).
	const uiModules = [];
	const uiOwners = new Map(); // shortName -> module name, for a readable collision error
	for (const source of sources) {
		const cand = ['ui/dist/app.js', 'ui/app.js', 'studio/dist/app.js', 'studio/app.js']
			.map((p) => path.join(source.root, p))
			.find((p) => fs.existsSync(p));
		if (!cand) continue;
		// short name = full package name, url-safe: "@" stripped, "/" → "--"
		// (@a/crm and @b/crm used to both stage ui/crm — audit finding 4). unscoped
		// names are unchanged, so existing /ui/<name>/app.js paths survive.
		const shortName = source.name.replace(/^@/, '').replace(/\//g, '--');
		const prevOwner = uiOwners.get(shortName);
		if (prevOwner) fail(`ui bundle collision: modules "${prevOwner}" and "${source.name}" both stage ui/${shortName}/app.js — rename one package.`);
		uiOwners.set(shortName, source.name);
		addEntry(path.join('ui', shortName, 'app.js'), cand);
		uiModules.push(shortName);
		// A UI bundle IS a contribution. Counting it here is what keeps the warning below honest —
		// a module whose whole purpose is a layout used to be told it "contributed no recognised
		// sources" while its layout was rendering in the app.
		contributedBy.add(source.name);
	}

	// A module that ships only folders the engine does not recognise compiles ✔ and contributes
	// NOTHING. Warn; do not fail, since a module that is temporarily source-free is the
	// operator's business, not the compiler's. Runs AFTER UI staging so a UI-only module counts.
	// ⚠ A module with a scaffolded-but-EMPTY kind folder is a module being AUTHORED, not a mistake.
	// `add modules` creates exactly that shape — eight empty kind folders — and a verb whose own
	// output triggers a warning reads as a broken install. The warning's remaining job is the case it
	// was written for: a module that ships nothing the engine recognises AT ALL, which is what
	// decision 156 cost two days. `kindDir` returns the flat path when neither layout exists, so this
	// is a genuine existence test on either spelling.
	const extensionNames = new Set(extensions.map((e) => e.name));
	for (const source of sources) {
		if (contributedBy.has(source.name) || extensionNames.has(source.name)) continue;
		if (kinds.some((k) => fs.existsSync(kindDir(source.root, k)))) continue;
		console.warn(`⚠ module "${source.name}" (${rel(source.root)}) contributed no recognised sources — its folder names must match a known kind (${kinds.join(', ')}) or it must ship a UI bundle at ui/app.js`);
	}

	// ---- mixins (descriptor v2): partial descriptors merged into the collections that list them ----
	const mixinDocs = new Map(); // id -> doc (with `src` for staleness)
	for (const [rt, entry] of entries) {
		const m = /^mixins\/(.+)\.mixin\.yaml$/.exec(rt);
		if (!m) continue;
		const doc = loadSource(entry.bytes.toString('utf8'), entry.sources[0].path);
		if (!doc || typeof doc !== 'object') fail(`${entry.sources[0].path}: a mixin is a mapping`);
		const bad = Object.keys(doc).filter((k) => !['name', 'description', 'use_when', 'fields', 'storage', 'ids', 'display', 'constraints'].includes(k));
		if (bad.length) fail(`${entry.sources[0].path}: unknown key(s) ${bad.join(', ')} — a mixin carries name · description · use_when · fields · storage · ids · display · constraints`);
		if (doc.name !== m[1]) fail(`${entry.sources[0].path}: name "${doc.name}" must equal the file's id "${m[1]}"`);
		if (!String(doc.description ?? '').trim()) console.warn(`⚠ mixin ${m[1]} has no description — it renders as a bare name in the orientation block every session loads`);
		mixinDocs.set(m[1], { ...doc, src: entry.sources[0] });
	}

	// ---- namespaces: the UNION of every module's declaration plus the workspace's (§8) ----------
	//
	// This used to be "the workspace package.json only, never per-module", and the reason was real: a
	// module that can declare a namespace can rename where another module's records live. What it
	// cost was decision 130's own acceptance test — "a module compiles alone in a bare workspace" —
	// which no NAMESPACED module could ever pass, because the consuming workspace had to edit its
	// manifest before the module would compile. That is precisely the coupling the rule forbids.
	//
	// Three rules keep the protection:
	//   1. ONE OWNER per namespace. Two modules declaring it is a hard error naming both.
	//   2. USING one requires the dependency (checked per collection, below) — otherwise the union
	//      would let a second module squat in the first's namespace silently. Before the union, B
	//      alone simply failed loudly, and that accident was the safer behaviour.
	//   3. A WORKSPACE declaration duplicating a module's is a WARNING. Every existing workspace
	//      declares at the workspace level, and an upgrade must not brick compile.
	//
	// The resolved set is STAMPED INTO THE MANIFEST, so `namespace.js`, `parseRef`, the store, `check`
	// and the extension are all unchanged — they read the artifact, exactly as they read
	// `storage.base`. Config rather than records for the same bootstrap reason `git-modules` is: a
	// reference has to be parseable before anything has been compiled.
	const nsOwners = new Map(); // namespace -> the module NAME that declares it
	for (const source of sources) {
		for (const ns of normalizeNamespaces(moduleNamespaces.get(source.name))) {
			const prev = nsOwners.get(ns);
			if (prev && prev !== source.name) {
				fail(`namespace "${ns}" is declared by ${moduleId(prev)} AND ${moduleId(source.name)} — one owner. Remove it from one (dt set modules/<m> namespaces=…).`);
			}
			nsOwners.set(ns, source.name);
		}
	}
	for (const ns of normalizeNamespaces(config.namespaces)) {
		const owner = nsOwners.get(ns);
		if (!owner) continue;
		console.warn(`⚠ namespace "${ns}" is declared both by module ${moduleId(owner)} and at the workspace level — the module's declaration is the one that TRAVELS, so the workspace copy is redundant. Drop it: dt set modules/${moduleId(owner)} namespaces=${ns}`);
	}
	const namespaces = normalizeNamespaces([...nsOwners.keys(), ...(config.namespaces ?? [])]);
	const collectionNames = [...descriptorGroups.keys()];
	for (const p of namespaceProblems(namespaces, collectionNames)) fail(p);
	// The silent failure this whole feature had to fix: a slash in a collection name used to compile
	// clean, land at `.dreamteamer/collections/<ns>/<name>.collection.yaml`, and then vanish — the
	// descriptor loader read one directory level, so the collection was simply absent from the
	// runtime while compile reported ✔ (the same shape as decision 156).
	// ⚠ THE STATED TRADE (§8): the namespace set is now a function of the INSTALLED MODULE SET, so
	// removing or disabling a namespace-owning module re-splits every reference into it. The record
	// layer's sentence is correct and cannot know that — `namespace.js` is pure and must stay so — so
	// the module half is appended here, where the module set is in hand.
	for (const p of unqualifiedProblems(collectionNames, namespaces)) {
		const guess = /but "([^"]+)" is not declared/.exec(p)?.[1];
		const gone = guess && prevManifestNamespaces(root).includes(guess) ? guess : null;
		fail(gone
			? `${p}\n  ⚠ "${gone}" WAS declared in the previous compile — by a module you just removed or disabled. Re-install it, or declare the namespace where the collection now lives: dt set modules/<m> namespaces=${gone}`
			: p);
	}

	// ---- collections: descriptor format v2, the only format read ---------------------------
	// The engine's own collections are an implicit dependency of every module: the entity kinds the
	// compiler materializes, plus `repos` (because `install repos/<id>` clones them).
	const CORE_COLLECTIONS = new Set([...kinds, ...DERIVED_KINDS, 'repos']);
	const engineName = engineId().replace(/@[^@]*$/, '');
	const wsDir = config.workspace_module;
	const wsModuleName = wsDir
		? sources.find((s) => rel(s.root) === path.join('modules', wsDir))?.name
		: pkg.name;
	// a declared git module whose clone is absent is an UNINSTALLED workspace (a fresh clone), so a
	// collection error there is named with the install, not left reading as a broken reference
	const uninstalled = Object.keys(config.git_modules ?? {}).filter((n) => !fs.existsSync(path.join(root, 'git_modules', n)));
	const collectionsFail = (msg) => fail(uninstalled.length
		? `${msg}\n  run \`dreamteamer install\` first — dreamteamer.git_modules declares ${uninstalled.join(', ')}, and no clone of ${uninstalled.length === 1 ? 'it' : 'them'} is on disk yet`
		: msg);
	const { compiled: compiledColls, inert: inertSources, moduleColls } = compileCollections({
		groups: descriptorGroups, mixins: mixinDocs, namespaces, nsOwners,
		runtimeKinds: new Set([...kinds, ...DERIVED_KINDS]), core: CORE_COLLECTIONS,
		moduleDeps, modulePeers, channelOf, wsModuleName, engineName, dataOwners,
		repoOf: (moduleRoot) => repoRootOf(moduleRoot, root), rel, dataPath: config.data_path ?? 'data',
		moduleId, fail: collectionsFail, warn: (m) => console.warn(m),
	});
	refusePlacementTransitions(root, compiledColls);
	counts.collections = 0;
	const mergedCount = [...compiledColls.values()].filter((c) => c.compiled.overlaid_by.length).length;
	for (const [name, c] of compiledColls) {
		entries.set(path.join('collections', `${name}.collection.yaml`), { sources: c.sources, bytes: Buffer.from(dump(c.doc, { noRefs: true })) });
		counts.collections++;
	}

	// ---- modules, projected ---------------------------------------------------------
	// One record per discovered module, written from what discovery and the package pass already
	// established. `package.json` remains the source of truth and compile keeps reading it — this
	// is a photograph, never an input (see collections/modules.collection.yaml for why it earns a
	// place in core at all).
	//
	// The id strips an npm scope so `@dreamteamer/crm` reads as `crm`, which is what every message
	// in this engine already calls it. A collision is a hard failure rather than a silent overwrite:
	// two modules answering to one id would make `dependencies` ambiguous, and an ambiguous edge is
	// worse than no diagram.
	const idByModule = new Map();
	for (const source of sources) {
		const id = moduleId(source.name);
		const clash = idByModule.get(id);
		if (clash && clash !== source.name) fail(`modules "${clash}" and "${source.name}" both resolve to the id "${id}" — rename one.`);
		idByModule.set(id, source.name);
	}
	for (const source of sources) {
		const id = moduleId(source.name);
		let pkg = {};
		try { pkg = JSON.parse(fs.readFileSync(path.join(source.root, 'package.json'), 'utf8')); } catch { /* inline workspace source */ }
		const mpkg = pkg.dreamteamer ?? {};
		// What this module is FOR, in one line. `dreamteamer.description` wins; npm's own top-level
		// `description` is the fallback, because it is the one place a package author already writes
		// that sentence — six modules on one dogfood workspace had authored it THERE and every
		// `dt list modules` row read `-` for description. There is no derivation past that and there
		// should not be: a module is the only place that knows.
		const description = [mpkg.description, pkg.description].find((s) => typeof s === 'string' && s.trim());
		// A module with no sentence renders as a bare title at the head of its section in the
		// orientation block — the one place a session learns what an AREA of the workspace is for.
		// Same shape as the per-collection warning: non-blocking, named per offender.
		if (!description) console.warn(`⚠ module ${source.name} has no description — set "description" in its package.json; it heads its own section in the orientation block every session loads`);
		const record = {
			name: source.name,
			// Authored wins; the derived fallback title-cases the id the same way a collection's
			// `title` is derived. `@dreamteamer/crm` -> "Crm" until crm declares "CRM" — which is
			// the point: the module is the only place that knows.
			title: typeof mpkg.title === 'string' && mpkg.title ? mpkg.title : titleCase(id),
			...(description ? { description } : {}),
			// §8: the namespaces THIS module declares — projected from its package.json, so
			// `dt list modules` answers "who owns hr?" without reading seven package.json files.
			...(normalizeNamespaces(mpkg.namespaces).length ? { namespaces: normalizeNamespaces(mpkg.namespaces) } : {}),
			// §10: the folder name, not an internal channel word. `dt status` then reads
			// `hr  git_modules @ 3f2a1c (dirty)` and needs no legend.
			location: locationOf(source, root),
			path: rel(source.root) || '.',
			// The module's RUNNABLE entry points — `bin/<file>`, the folder NON_SOURCE_DIRS waves through.
			// Skills and commands render into the orientation block; a module whose procedure is a
			// script did not, so a session planned `dt add` writes the tooling forbids. This is the
			// POINTER that the procedure exists, never its arguments — those stay in the skill.
			...(binEntries(source.root).length ? { bin: binEntries(source.root) } : {}),
			...(mpkg.owns_data === true ? { owns_data: true } : {}),
			// Declared module names become record IDS here, because that is what an x-reference
			// resolves against. An undeclared/unknown name would dangle, and `check` would say so —
			// but compile has already failed on that case (the acyclicity pass resolves every one).
			// ⚠ A reference VALUE is `<collection>/<id>`, never a bare id — `check` rejects the bare
			// form, which is exactly what it did to the first pass of this projection (63 violations).
			...(moduleDeps.get(source.name)?.length
				? { dependencies: moduleDeps.get(source.name).map((n) => `modules/${moduleId(n)}`) }
				: {}),
			...(modulePeers.get(source.name)?.length
				? { peer_collections: modulePeers.get(source.name).map((c) => `collections/${c}`) }
				: {}),
			...(moduleColls.get(source.name)?.size
				? { collections: [...moduleColls.get(source.name)].sort().map((c) => `collections/${c}`) }
				: {}),
		};
		const bytes = Buffer.from(dump(record));
		// ⚠ The source hash is the hash of the SOURCE FILE, not of the projected record. Hashing the
		// output made every source "differ" on the next run, so `staleness` reported the workspace
		// stale immediately after a clean compile — the one signal that has to stay trustworthy.
		const pkgPath = path.join(source.root, 'package.json');
		const pkgBytes = fs.existsSync(pkgPath) ? fs.readFileSync(pkgPath) : bytes;
		entries.set(path.join('modules', `${id}.module.yaml`), {
			sources: [{ path: rel(pkgPath), hash: sha256(pkgBytes) }],
			bytes,
		});
		counts.modules = (counts.modules ?? 0) + 1;
	}

	// ---- the workspace's own hand-written instructions -------------------------------
	// ONE source, rendered verbatim into every harness's instruction file. It is registered as a
	// manifest entry for exactly one reason: `staleness` walks manifest sources, so a file that is
	// not one can be edited forever without `dt status` ever saying the harness files lag it — and a
	// silent lag on the file carrying the operator's rules is the worst possible thing to be silent
	// about. The runtime copy is never read by anything; the manifest ENTRY is the whole point.
	// uppercase, like the harness files it feeds; the readdir — not existsSync — because on a
	// case-insensitive filesystem `dreamteamer.md` and `DREAMTEAMER.md` are one path
	if (fs.readdirSync(root).includes('dreamteamer.md')) fail(`the instructions source is DREAMTEAMER.md, and dreamteamer.md is not read — rename it (git mv dreamteamer.md DREAMTEAMER.md; on a case-insensitive filesystem go through a temporary name), then compile.`);
	const instructionsPath = path.join(root, INSTRUCTIONS_SOURCE);
	if (fs.existsSync(instructionsPath)) {
		const bytes = fs.readFileSync(instructionsPath);
		refuseManagedMarkers(bytes.toString('utf8'), rel(instructionsPath));
		entries.set('instructions.md', { sources: [{ path: rel(instructionsPath), hash: sha256(bytes) }], bytes });
	}

	// ---- unresolved references are compile errors (an agent's declared skills)
	const skillIds = new Set([...entries.keys()].filter((k) => k.startsWith('skills/')).map((k) => k.split('/')[1]));
	for (const [rt, e] of entries) {
		// A SKILL whose frontmatter is not YAML compiled ✔ and was refused one gate later by `check`,
		// naming the compiled copy under .dreamteamer/ that nobody can edit — found when an installed
		// package shipped a description holding `: `. Parsed here, where the source path is known.
		if (/^skills\/[^/]+\/SKILL\.md$/.test(rt)) {
			const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(e.bytes.toString('utf8'));
			if (fm) loadSource(fm[1], e.sources[0].path);
		}
		if (rt.startsWith('agents/')) {
			const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(e.bytes.toString('utf8'));
			const doc = fm ? loadSource(fm[1], e.sources[0].path) : {};
			for (const sk of doc.skills ?? []) {
				if (!skillIds.has(String(sk).replace(/^skills\//, ''))) fail(`${rt}: references unknown skill "${sk}"`);
			}
		}
	}
	if (disabledHits.size < disabled.size) {
		for (const d of disabled) if (!disabledHits.has(d)) console.warn(`⚠ dreamteamer.disable entry "${d}" matched nothing`);
	}

	// ---- ui-views and command-bindings: validated against the collection each one names ----------
	// `layout` is not validated: the engine validates a value only where it interprets it, and a layout
	// id is opaque payload for whichever surface renders it (an unregistered one degrades there). Filter
	// operators, field names and templates the engine does interpret, so a typo fails here rather than
	// as a view that draws nothing or a gate that never opens. A view's compiled file is its source plus
	// `compiled.display`: its display merged over its collection's.
	const collectionOf = (ref) => {
		const name = String(ref ?? '').replace(/^collections\//, '');
		const e = name && entries.get(path.join('collections', `${name}.collection.yaml`));
		return e ? load(e.bytes.toString('utf8')) : null;
	};
	const fieldsKnown = (d) => (d ? fieldsOf(d) : undefined);
	// a module declaring a peer that is not installed may name a field that peer's overlay adds
	const lenientFor = (file) => {
		const owner = sources.map((s) => ({ s, at: rel(s.root) })).filter(({ at }) => !at || file.startsWith(`${at}/`)).sort((a, b) => b.at.length - a.at.length)[0]?.s;
		return (modulePeers.get(owner?.name) ?? []).some((p) => !descriptorGroups.has(p));
	};
	const v1Sources = [];
	for (const [rt, e] of entries) {
		if (!rt.startsWith('ui-views/')) continue;
		const file = e.sources[0].path;
		const view = loadSource(e.bytes.toString('utf8'), file);
		const d = view?.collection ? collectionOf(view.collection) : null;
		const groupFields = (f) => { const t = d && f ? targetsOf(fieldsOf(d)[f]) : null; return Array.isArray(t) && t.length === 1 ? fieldsKnown(collectionOf(`collections/${t[0]}`)) : undefined; };
		const { errors, warnings, v1 } = viewErrors(view, { file, fields: fieldsKnown(d), groupFields, lenient: lenientFor(file) });
		if (v1) { v1Sources.push(file); continue; }
		if (errors.length) fail(errors.join('\n  '));
		for (const w of warnings) console.warn(`⚠ ${w}`);
		const text = e.bytes.toString('utf8');
		e.bytes = Buffer.from(`${text}${text.endsWith('\n') ? '' : '\n'}${dump({ compiled: { display: viewDisplay(d ? displayOf(d) : {}, view) } })}`);
	}
	const commandIds = new Set([...entries.keys()].filter((k) => k.startsWith('commands/')).map((k) => path.basename(k).replace(/\.command\.md$/, '')));
	for (const [rt, e] of entries) {
		if (!rt.startsWith('command-bindings/')) continue;
		const file = e.sources[0].path;
		const b = loadSource(e.bytes.toString('utf8'), file);
		if (bindingErrors(b, { file }).v1) { v1Sources.push(file); continue; }
		const cmd = String(b?.command ?? '').replace(/^commands\//, '');
		if (!cmd || !commandIds.has(cmd)) fail(`${rt}: references unknown command "${b?.command ?? ''}"`);
		const coll = String(b?.collection ?? '').replace(/^collections\//, '');
		if (!coll || !descriptorGroups.has(coll)) fail(`${rt}: references unknown collection "${b?.collection ?? ''}"`);
		const { errors, warnings } = bindingErrors(b, { file, fields: fieldsKnown(collectionOf(coll)), lenient: lenientFor(file) });
		if (errors.length) fail(errors.join('\n  '));
		for (const w of warnings) console.warn(`⚠ ${w}`);
	}
	if (v1Sources.length) fail(v1Refusal(v1Sources.sort()));

	// ---- extension analysis ------------------------------------------------------------
	// After the whole compile is assembled and BEFORE any output is replaced: an extension that owns a
	// source kind judges its entries against the final merged schemas (proofs name artifacts and filter
	// on fields, so only the assembled workspace can say whether they mean anything). The draft is data
	// only — no filesystem writer, no Store, no environment VALUES, key names only. An error fails the
	// compile exactly like a built-in check; notes print after the summary.
	const notes = [];
	if (extensions.some((e) => e.analyze)) {
		const descriptors = new Map();
		for (const [rt, e] of entries) {
			if (!rt.startsWith('collections/')) continue;
			const doc = load(e.bytes.toString('utf8'));
			if (doc?.name) descriptors.set(doc.name, doc);
		}
		const draft = Object.freeze({
			entries,
			descriptors,
			modules: sources.map((s) => ({ id: moduleId(s.name), name: s.name, root: rel(s.root) || '.', channel: s.channel })),
			declaredVars: [...declaredVars],
			declaredEnv: [...declaredEnv.keys()],
			previousManifest: prevManifest,
			parse: (rt) => loadSource(entries.get(rt).bytes.toString('utf8'), entries.get(rt).sources[0].path),
		});
		for (const ext of extensions) {
			if (!ext.analyze) continue;
			const out = ext.analyze(draft) ?? {};
			if (out.errors?.length) fail(out.errors.join('\n  '));
			for (const w of out.warnings ?? []) console.warn(`⚠ ${w}`);
			notes.push(...(out.notes ?? []));
		}
	}

	// ---- extension code for the harness pass, run BEFORE anything is replaced ------------
	// A contributed renderer that throws must leave the last good runtime and every harness file
	// byte-for-byte as they were — so it runs here, on data, and the write pass below only writes.
	let contributions;
	try { contributions = renderContributions({ entries, harnesses, version: engineVer, extensions }); }
	catch (e) { fail(e.message); }

	// ---- materialize .dreamteamer ------------------------------------------------
	// mkdir the runtime ROOT unconditionally: with zero entries nothing below created it, so the
	// manifest write at the end failed ENOENT — `init` followed by `compile` in a fresh workspace
	// crashed on the one path a new user takes first.
	fs.mkdirSync(RUNTIME, { recursive: true });
	// clear each kind's folder, plus `system/` — a runtime compiled by a pre-flatten engine has the
	// whole tree under there, and leaving it would keep stale descriptors on disk beside the fresh
	// ones. Never `rm -rf` the runtime root itself: it also holds the write lock.
	// ⚠ DERIVED_KINDS too, not just KINDS. `modules/` is projected rather than staged, so it was not
	// in this loop and never got cleared — a module that was RENAMED or REMOVED left its old record
	// behind forever, listing collections that no longer exist. `check` reads those records like any
	// other, so it surfaced as a dangling reference in a file nobody had touched, twice in one day
	// (the workspace module's own record after it was renamed, and a domain module's after it was
	// folded into another). The
	// runtime is build output; stale build output is the compiler's problem, not the reader's.
	// ⚠ AND every kind the PREVIOUS compile staged: an extension uninstalled since then leaves its
	// compiled folder behind otherwise, read by nothing and listed by `dt list` for ever.
	const prevKinds = (prevManifest?.['source-kinds'] ?? []).map((k) => k.kind).filter((k) => typeof k === 'string' && /^[a-z][a-z0-9-]*$/.test(k));
	for (const kind of new Set([...kinds, ...DERIVED_KINDS, ...prevKinds])) fs.rmSync(path.join(RUNTIME, kind), { recursive: true, force: true });
	fs.rmSync(path.join(RUNTIME, 'system'), { recursive: true, force: true });
	fs.rmSync(path.join(RUNTIME, 'ui'), { recursive: true, force: true });
	for (const [rt, e] of entries) {
		const dest = path.join(RUNTIME, rt);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, e.bytes);
	}

	// ---- harness adapters (dispatch table lives in harnesses.js) -------------------
	// What the harness blocks should TELL an agent about where sources live — measured, not assumed.
	// A workspace still on the nested layout was being handed prose naming the flat one, and that
	// block is the first thing a session reads.
	const anyFlat = sources.some((s) => kinds.some((k) => fs.existsSync(path.join(s.root, k))));
	const anyNested = sources.some((s) => kinds.some((k) => fs.existsSync(path.join(s.root, 'system', k))));
	const sourceLayout = anyFlat && anyNested ? 'mixed' : anyNested ? 'nested' : 'flat';
	const { outputs: adapterOutputs, blocks: adapterBlocks, summary: harnessSummary } = runHarnessAdapters({ root, entries, harnesses, prevManifest, sourceLayout, namespaces, version: engineVer, workspaceModule: config.workspace_module ?? '', extensions, kinds: contributed.map((k) => k.kind), contributions });
	// the root harness files are build output: gitignored, so a bare clone gets them from `compile`
	{
		const added = ensureGitignored(root, [...new Set(adapterBlocks)].filter((f) => !f.includes('/')));
		if (added.length) console.log(`✔ .gitignore now ignores ${added.join(', ')} — generated by compile; \`git rm --cached\` them once if they were tracked`);
	}

	// ---- provenance manifest ------------------------------------------------------
	const manifest = {
		compiled: new Date().toISOString(),
		host: engineId(),
		// ⚠ THE VERSION AS A PLAIN SEMVER, beside `host`, for a consumer that has to COMPARE it.
		//
		// The VS Code extension pins a HARD MINIMUM engine version and refuses to load below it with
		// a clear message — a version check rather than a capability handshake, because a handshake
		// answers "can you do X" one capability at a time and the failure it has to prevent is
		// structural: an extension built against this wave's exports calling into a 0.17 engine
		// throws out of `activate()` before the tree view exists, which VS Code renders as its
		// `viewsWelcome` text — the symptom naming the one thing that is definitely fine.
		//
		// `host` cannot serve: it is `name@version` and needs parsing, and a consumer that parses a
		// display string is a consumer that breaks when the display changes. The other two pin
		// surfaces are `engineVersion()` (in-process) and `dt --version` (a subprocess).
		engine: engineVer,
		// The declared namespace list, carried across the boundary so the RECORD layer can split a
		// reference without importing the compiler or re-reading package.json — the same reason
		// `storage.base` is a field instead of a path test. An older runtime has no key here, which
		// reads as "no namespaces", which is exactly right for a workspace that never declared any.
		namespaces,
		// The extensions this runtime was compiled WITH, and the source kinds they staged — so the next
		// compile can prune a kind whose extension is gone, and `staleness` can walk a contributed kind
		// without loading any extension code.
		...(extensions.length ? { extensions: extensions.map((e) => ({ name: e.name, version: e.version })) } : {}),
		...(contributed.length ? { 'source-kinds': contributed.map((k) => ({ kind: k.kind, exclude: k.exclude, extension: k.extension })) } : {}),
		// ⚠ BOTH KEYS FOR ONE RELEASE. `location` is the new spelling; `channel` stays so a reader
		// that has not moved — `runtime.sourceRoots`'s npm filter, and the extension — keeps working
		// against a runtime this engine compiled. Removed in 0.20.0.
		modules: sources.map((s) => ({
			name: s.name,
			location: locationOf(s, root),
			channel: s.channel,
			root: rel(s.root) || '.',
		})),
		ui: uiModules.sort(),
		// modules refused for their engine floor — staleness does not report their files as new
		...(refused.size ? { refused: [...refused].map(([name, engine]) => ({ name, engine })) } : {}),
		// overlays of a peer nobody installed: compiled into nothing, still sources — staleness knows them
		...(inertSources.length ? { inert: inertSources } : {}),
		'adapter-outputs': adapterOutputs.sort(),
		// the root files whose managed BLOCK this compile rewrote — never pruned
		'adapter-blocks': adapterBlocks.sort(),
		entries: Object.fromEntries(
			[...entries].map(([rt, e]) => [rt, { sources: e.sources, hash: sha256(e.bytes) }]) // sources: [{path, hash}] — per-SOURCE hashes power staleness
		),
	};
	fs.writeFileSync(path.join(RUNTIME, 'manifest.yaml'), dump(manifest));

	const summary = kinds.filter((k) => counts[k]).map((k) => `${counts[k]} ${k}${k === 'collections' && mergedCount ? ` (${mergedCount} merged)` : ''}`).join(', ');
	const sourceLabel = config.workspace_module
		? `${sources.length} module(s) (workspace_module: ${config.workspace_module})`
		: `${sources.length - 1} module(s) + workspace`;
	console.log(`✔ compiled ${summary || 'nothing'} from ${sourceLabel} → .dreamteamer`);
	for (const line of harnessSummary) console.log(`✔ harness ${line}`);

	for (const n of notes) console.log(n);
	return 0;
}

/** What the PREVIOUS compile resolved, for the one message that needs to know a namespace has just
 *  disappeared rather than never existing. Read off the runtime on disk, which at this point in
 *  compile is still the old one. */
function prevManifestNamespaces(root) {
	return normalizeNamespaces(readManifest(root)?.namespaces);
}


// staleness: does any manifest entry's SOURCE differ from what was compiled, or is a
// source file missing/new? used by `status` and warned about at every tool entry.
export function staleness(root) {
	const manifest = readManifest(root);
	if (!manifest) return { compiled: false, stale: [], message: 'no compiled runtime — run `dreamteamer compile`' };
	const stale = [];
	for (const [rt, e] of Object.entries(manifest.entries ?? {})) {
		for (const src of e.sources) {
			// sources are {path, hash}; tolerate the pre-merge string form
			const srcPath = typeof src === 'string' ? src : src.path;
			const srcHash = typeof src === 'string' ? e.hash : src.hash;
			const p = path.join(root, srcPath);
			if (!fs.existsSync(p)) stale.push(`${srcPath} (removed)`);
			else if (sha256(fs.readFileSync(p)) !== srcHash) stale.push(`${srcPath} (changed)`);
		}
	}
	// new source files not present in the manifest — scan winning module roots across
	// ALL channels (shadowed copies were not compiled, so their files are not "new")
	const known = new Set([
		...Object.values(manifest.entries ?? {}).flatMap((e) => e.sources.map((s) => (typeof s === 'string' ? s : s.path))),
		...(manifest.inert ?? []).map((s) => s.path),
	]);
	for (const src of manifest.inert ?? []) {
		const p = path.join(root, src.path);
		if (!fs.existsSync(p)) stale.push(`${src.path} (removed)`);
		else if (sha256(fs.readFileSync(p)) !== src.hash) stale.push(`${src.path} (changed)`);
	}
	let pkg = {};
	try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { /* no pkg */ }
	const wm = pkg.dreamteamer?.workspace_module;
	const found = discoverModules(root, pkg);
	// ⚠ A DISABLED ENTITY IS NOT A NEW ONE, AND THIS IS THE DIFFERENCE BETWEEN A WARNING AND A LIE.
	// `compile` skips every source named by an ENTITY-LEVEL `dreamteamer.disable` entry
	// (`<module>/<entity>`) before `addEntry`, so that file's path never becomes a manifest source.
	// This scan used to have no knowledge of that filter, so it found the file on disk, found it
	// absent from `known`, and reported it `(new, uncompiled)` — permanently, because every future
	// compile skips it exactly the same way. The workspace was told to run a compile that could not
	// possibly clear the warning, at every tool entry, for as long as the disable stood.
	//
	// Two consuming workspaces were sitting in that state when this was found, one of them with a
	// clean compile seconds earlier. The MODULE-level form (a bare name) needs no handling here:
	// `discoverModules` drops the whole module, so its files are never walked at all.
	//
	// The root itself, when a workspace declares no `workspace-module`, is not a named module, so no
	// `<module>/<entity>` entry can address its sources — it is walked unfiltered, as before.
	const disabledEntities = new Set((pkg.dreamteamer?.disable ?? []).filter((d) => typeof d === 'string' && !isPackageEntry(d)));
	const refused = new Set((manifest.refused ?? []).map((r) => r.name));
	const roots = [...(wm ? [] : [{ name: null, root }]), ...found.modules.filter((m) => !refused.has(m.name)).map((m) => ({ name: m.name, root: m.root }))];
	// the kinds the last compile STAGED, read off its manifest — staleness loads no extension code
	const contributedKinds = (manifest['source-kinds'] ?? []).map((k) => ({ kind: k.kind, exclude: k.exclude ?? [] }));
	for (const { name: moduleName, root: r } of roots) {
		for (const kind of [...KINDS, ...contributedKinds.map((k) => k.kind)]) {
			const dir = kindDir(r, kind);
			if (!fs.existsSync(dir)) continue;
			for (const f of walk(dir)) {
				const rel = path.relative(dir, f).split(path.sep).join('/');
				if (excludedFromKind(contributedKinds, kind, rel)) continue;
				// The SAME id derivation `compile` uses, so the two can never disagree about which
				// file a disable entry names.
				//
				// ⚠ AND THE TWO KINDS DERIVE IT DIFFERENTLY. `compile` walks collections recursively,
				// so a collection's id is its whole relative path (it may carry a namespace segment,
				// `<ns>/<name>`); every other kind it reads with a flat `readdirSync`, so the entity
				// is the TOP-LEVEL entry and a folder-shaped one — a skill is a directory holding
				// `SKILL.md` — is named by the folder alone. Matching the full path for those meant a
				// disabled SKILL still counted as stale, because `working-with-tasks/SKILL.md` is not
				// `working-with-tasks`. Caught against a real workspace whose disable list held one
				// of each: the ui-view cleared and the skill did not.
				if (moduleName) {
					const relEntity = kind === 'collections' ? rel : rel.split('/')[0];
					const entityId = relEntity.replace(/\.[^.]+\.(yaml|md|json)$/, '');
					if (disabledEntities.has(`${kind}/${entityId}`)) continue;
				}
				const relPath = path.relative(root, f);
				if (!known.has(relPath)) stale.push(`${relPath} (new, uncompiled)`);
			}
		}
	}
	// ⚠ `dreamteamer.md` is a compile source that is NOT under a KIND directory, so the walk above
	// cannot reach it — and its CREATION is the one moment that matters most: day one in an adopting
	// workspace, when no harness file carries an instructions block yet. Every later EDIT was already
	// caught by the manifest-source walk at the top of this function; only the first write was silent,
	// and it reported `.dreamteamer is fresh` while the rules reached no agent at all.
	if (fs.existsSync(path.join(root, INSTRUCTIONS_SOURCE)) && !known.has(INSTRUCTIONS_SOURCE)) {
		stale.push(`${INSTRUCTIONS_SOURCE} (new, uncompiled)`);
	}
	return { compiled: true, stale, manifest };
}

export function warnIfStale(root) {
	const s = staleness(root);
	if (!s.compiled) console.warn(`⚠ ${s.message}`);
	else if (s.stale.length) console.warn(`⚠ .dreamteamer is stale (${s.stale.length} source(s) differ) — run \`dreamteamer compile\``);
	return s;
}





/**
 * A `storage.under` that is REMOVED or CHANGED while records still sit under the old declaration is
 * refused. The compiled descriptor is the only thing that knows where those records are: the moment it
 * is rewritten, listing, check and relocate all read the new layout and the old child folders fall out
 * of every walk. So the runtime about to be replaced is read first, and a transition with records in
 * the way names the safe order: `relocate --to-root` under the OLD declaration, then compile, then
 * `relocate`. Adding `under` moves nothing out of sight and is not refused.
 */
function refusePlacementTransitions(root, compiledColls) {
	const previous = loadCompiledDescriptors(root);
	if (!previous) return;
	for (const [name, c] of compiledColls) {
		const prev = previous.get(name);
		if (!prev?.compiled) continue; // a runtime compiled from v1 sources: placement carried over by the converter unchanged
		const was = storageOf(prev).under;
		if (!was?.collection || !was.subfolder) continue;
		const parent = previous.get(was.collection);
		if (!parent?.compiled) continue;
		const now = c.storage.under ? { ...c.storage.under, collection: c.compiled.under_collection } : null;
		const newParentPath = now ? compiledColls.get(now.collection)?.storage.path : null;
		const parentPath = storageOf(parent).path;
		const same = now && now.collection === was.collection && now.subfolder === was.subfolder && newParentPath === parentPath;
		if (same) continue;
		let n = 0;
		for (const r of placedRecords(prev, path.join(root, storageOf(prev).path), path.join(root, parentPath))) if (r.parentId !== null) n++;
		if (!n) continue;
		const what = !now ? 'storage.under was removed'
			: now.collection !== was.collection || now.subfolder !== was.subfolder ? `storage.under changed (${was.subfolder} → ${now.subfolder})`
			: `${was.collection}'s storage.path changed (${parentPath} → ${newParentPath})`;
		fail(`collection "${name}": ${what}, but ${n} ${name} record(s) still sit inside ${was.collection} folders (${parentPath}/<id>/${was.subfolder}/) — compiling would stop every reader seeing them. First move them out under the CURRENT declaration: dreamteamer relocate ${name} --to-root, then compile${now ? `, then dreamteamer relocate ${name} to place them again` : ''}.`);
	}
}

// a bad source THROWS (review finding 8: process.exit killed --watch on the first typo
// and made server-triggered recompiles impossible). the CLI boundary prints and exits.
export class CompileError extends Error {}


// ⚠ A MANAGED MARKER INSIDE `dreamteamer.md` IS A REFUSAL, not something to escape around.
// The file is rendered VERBATIM into a managed block, and `writeBlock` finds that block by the FIRST
// occurrence of its begin marker anywhere in the file — so a marker quoted inside the rendered text
// is found before the real delimiter. Both directions were measured on a fixture:
//
//   - quoting the ORIENTATION pair: the orientation pass rewrites the quoted region, the instructions
//     pass that runs immediately after restores it from source, and the real orientation block is
//     never touched again. It silently keeps describing the schema of the day it was written, while
//     `compile` exits 0 and `status` reports the runtime fresh.
//   - quoting the INSTRUCTIONS end marker: the block is closed at the quote and a second end line is
//     appended, so all three committed root files grow by ~40 bytes and one duplicated line per
//     compile, without ever reaching a fixed point.
//
// Escaping the markers on the way out is the alternative, and it is not one: the whole promise of
// this file is that what was written is what every agent reads, and an escaped marker is not that.
// A rule ABOUT the block describes it instead of quoting it.
/** The one hand-written root source. Named once: `compile` reads it and `staleness` looks for it. */
export const INSTRUCTIONS_SOURCE = 'DREAMTEAMER.md';

const MANAGED_MARKERS = [
	['the orientation block', BEGIN],
	['the orientation block', END],
	['the instructions block', INSTRUCTIONS_BEGIN],
	['the instructions block', INSTRUCTIONS_END],
];

function refuseManagedMarkers(text, srcPath) {
	const lines = text.split('\n');
	for (const [i, line] of lines.entries()) {
		for (const [which, marker] of MANAGED_MARKERS) {
			if (!line.includes(marker)) continue;
			fail(`${srcPath}:${i + 1}: contains the managed marker ${marker}, which delimits ${which} in the harness files. This source is rendered verbatim into that block, so the quoted copy is found before the real delimiter and the block is rewritten around the wrong place. Describe the block instead of quoting its marker.`);
		}
	}
}

function fail(msg) {
	throw new CompileError(`compile error: ${msg}`);
}
