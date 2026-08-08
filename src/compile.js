// dreamteamer compile — materialize (modules × workspace sources) into .dreamteamer,
// the single runtime read surface: copies + provenance manifest, then harness adapters.
// explicit only; nothing rebuilds implicitly.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { load, dump } from './yaml.js';
import { walk } from './records.js';
import { unknownOperators } from './filter.js';
// circular on paper in earlier versions — safe: both sides only
// call at run time, same pattern as store.js ↔ compile.js.
import { runHarnessAdapters } from './harnesses.js';
import { satisfies } from './semver.js';
import { readManifest, runtimeDir } from './runtime.js';

// re-exported, not moved: `readManifest` is in the VS Code extension's hand-maintained engine
// contract as `compileMod.readManifest` (engine.ts), and a removed export is the same cross-repo
// break as a removed file — decision 139.
export { readManifest };

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

export const KINDS = ['collections', 'skills', 'agents', 'commands', 'command-bindings', 'ui-views', 'collection-templates'];
const FOLDER_KINDS = new Set(['skills']); // folder-shape entities: copy the whole record folder

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
const NON_SOURCE_DIRS = new Set([
	'node_modules', 'data', 'state', 'media', 'bin', 'src', 'lib', 'scripts', 'studio',
	'docs', 'dist', 'build', 'test', 'tests', 'coverage', 'system', // 'system': the pre-flatten layout
]);

/** Unrecognised source-root folders in a module, or [] for the workspace root (a vault legitimately
 *  holds arbitrary directories — this gate is about PACKAGES, whose folders all mean something). */
function strayKindDirs(source, wsRoot, declaredIgnore) {
	if (path.resolve(source.root) === path.resolve(wsRoot)) return [];
	const allow = new Set([...KINDS, ...NON_SOURCE_DIRS, ...declaredIgnore]);
	return fs.readdirSync(source.root, { withFileTypes: true })
		.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !allow.has(e.name))
		.map((e) => e.name)
		.sort();
}

const sha256 = (buf) => 'sha256:' + createHash('sha256').update(buf).digest('hex');

// channel -> the directory the operator knows it by (used in shadow warnings)
export const CHANNEL_LABEL = { inline: 'modules', git: 'git_modules', npm: 'node_modules' };

// module discovery, three channels in precedence order: inline modules/* >
// git_modules/* > npm deps (declared in package.json, NOT a node_modules scan).
// same NAME in two channels = the same module delivered twice — the more local
// copy wins (npm-link semantics); shadows are returned for warning/status, never
// compiled. different-name identity collisions stay hard errors downstream.
export function discoverModules(root, pkg) {
	const byName = new Map(); // name -> {name, root, channel}
	const shadows = []; // {name, winner, loser} — channels
	const tryAdd = (name, srcRoot, channel) => {
		const existing = byName.get(name);
		if (existing) { shadows.push({ name, winner: existing.channel, loser: channel }); return; }
		byName.set(name, { name, root: srcRoot, channel });
	};
	const scanDir = (dir, channel) => {
		if (!fs.existsSync(dir)) return;
		for (const name of fs.readdirSync(dir).sort()) {
			const srcRoot = path.join(dir, name);
			const pkgPath = path.join(srcRoot, 'package.json');
			if (!fs.existsSync(pkgPath)) continue;
			try {
				const mpkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
				if ('dreamteamer' in mpkg) tryAdd(mpkg.name ?? name, srcRoot, channel);
			} catch { /* unparseable package.json — skip */ }
		}
	};
	scanDir(path.join(root, 'modules'), 'inline');
	scanDir(path.join(root, 'git_modules'), 'git');
	for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).sort()) {
		const srcRoot = path.join(root, 'node_modules', dep);
		try {
			const mpkg = JSON.parse(fs.readFileSync(path.join(srcRoot, 'package.json'), 'utf8'));
			if ('dreamteamer' in mpkg) tryAdd(mpkg.name ?? dep, srcRoot, 'npm');
		} catch { /* dep not installed or no package.json — skip */ }
	}
	return { modules: [...byName.values()], shadows };
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
		const flag = mpkg.dreamteamer?.['owns-data'];
		if (flag === undefined || flag === false) continue;
		if (flag !== true) fail(`module "${s.name}": "owns-data" must be true or false (got ${JSON.stringify(flag)})`);
		// Decided from the CHANNEL, never by asking git — compile shells out to git nowhere and
		// must keep working in a freshly-`init`ed directory that is not a repo yet.
		if (s.channel === 'npm') {
			fail(`module "${s.name}" sets owns-data, but it is installed under node_modules/ — that path is never committed, so its records could not be saved. Vendor it into modules/ or install it as a git module.`);
		}
		if (s.channel === 'git' && !fs.existsSync(path.join(s.root, '.git'))) {
			fail(`module "${s.name}" sets owns-data, but ${rel(s.root)} is not a git clone — git_modules/ is gitignored by the workspace, so its records could never be committed.`);
		}
		owners.set(s.name, { root: s.root, channel: s.channel });
	}
	return owners;
}

/** The git repo that will hold a module's records: nearest `.git` at or above the module root,
 *  as a workspace-relative path (`.` = the workspace itself). `.git` may be a FILE — worktrees
 *  and submodules write a pointer file rather than a directory — so existsSync, not isDirectory. */
function repoRootOf(moduleRoot, wsRoot) {
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

export function compile({ root, pkg }) {
	const RUNTIME = runtimeDir(root);
	const config = pkg.dreamteamer ?? {};
	const harnesses = config.harnesses ?? ['claude-code'];
	const rel = (p) => path.relative(root, p);

	// ---- discover sources: channel modules then the workspace's own -----------------
	const { modules: discovered, shadows } = discoverModules(root, pkg);
	for (const s of shadows) console.warn(shadowWarning(s));
	const sources = [...discovered];
	// workspace-owned sources: either at the root (classic layout) or in the designated
	// workspace module under modules/ (config `workspace-module` — "the workspace is itself a
	// module", made literal). when the key is set the root is NOT read, so the two layouts can
	// never fork — and a stray source folder up there is a loud error rather than a silent drop.
	if (!config['workspace-module']) {
		sources.push({ name: pkg.name, root, channel: 'inline' });
	} else {
		const strays = [];
		if (fs.existsSync(path.join(root, 'system')) && [...walk(path.join(root, 'system'))].length) strays.push('system/');
		for (const kind of KINDS) {
			const dir = path.join(root, kind);
			if (fs.existsSync(dir) && [...walk(dir)].length) strays.push(`${kind}/`);
		}
		if (strays.length) {
			fail(`the workspace root contains sources (${strays.join(', ')}) but workspace-module="${config['workspace-module']}" is set — they would be silently ignored.\n  move them into modules/${config['workspace-module']}/ (decision 22).`);
		}
	}

	// ---- module package pass: engine ranges + env declarations (M4) ---------------
	// both are WARNINGS, never errors — a version skew or missing secret must not
	// brick a solo operator's workspace at compile time.
	const engineVer = engineVersion();
	const declaredEnv = new Map(); // env key -> [module names]
	const moduleIgnores = new Map(); // module name -> non-source folders it declares (strayKindDirs)
	for (const source of sources) {
		let mpkg;
		try { mpkg = JSON.parse(fs.readFileSync(path.join(source.root, 'package.json'), 'utf8')); } catch { continue; }
		const ignore = mpkg.dreamteamer?.ignore;
		if (ignore !== undefined) {
			if (!Array.isArray(ignore)) fail(`module "${source.name}": "ignore" must be a list of folder names (got ${JSON.stringify(ignore)})`);
			moduleIgnores.set(source.name, ignore.map(String));
		}
		const range = mpkg.dreamteamer?.engine;
		if (range) {
			const ok = satisfies(engineVer, range);
			if (ok === false) console.warn(`⚠ module ${source.name} declares engine "${range}" — running engine is ${engineVer} (out of range; compile continues)`);
			else if (ok === null) console.warn(`⚠ module ${source.name}: engine range "${range}" not understood by the built-in checker (see src/semver.js) — not verified`);
		}
		for (const k of mpkg.dreamteamer?.env ?? []) {
			if (!declaredEnv.has(k)) declaredEnv.set(k, []);
			declaredEnv.get(k).push(source.name);
		}
	}
	if (declaredEnv.size) {
		// .env is parsed for KEY names ONLY — values never reach any output or the manifest
		const envPath = path.join(root, '.env');
		if (!fs.existsSync(envPath)) {
			console.warn(`⚠ no .env — modules declare env keys: ${[...declaredEnv.keys()].join(', ')} (see .env.example)`);
		} else {
			const present = new Set();
			for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
				const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
				if (m) present.add(m[1]);
			}
			for (const [k, mods] of declaredEnv) {
				if (present.has(k)) continue;
				for (const mod of mods) console.warn(`⚠ module ${mod} declares env key ${k} — missing from .env (see .env.example)`);
			}
		}
	}

	const dataOwners = dataOwningModules(sources, fail, rel);

	const disabled = new Set(config.disable ?? []);
	const disabledHits = new Set();

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
	const contributed = new Set();

	for (const source of sources) {
		// an unrecognised folder at a module root is a typo'd kind or a kind the engine dropped —
		// both of which used to compile ✔ and contribute nothing (see NON_SOURCE_DIRS)
		const strays = strayKindDirs(source, root, moduleIgnores.get(source.name) ?? []);
		if (strays.length) {
			fail(`module "${source.name}" (${rel(source.root)}) has folder(s) that are not a known kind: ${strays.join(', ')}
  known kinds: ${KINDS.join(', ')}
  if these are not sources, declare them: "dreamteamer": { "ignore": [${strays.map((s) => `"${s}"`).join(', ')}] } in ${rel(path.join(source.root, 'package.json'))}`);
		}
		for (const kind of KINDS) {
			// a half-moved module compiles its flat half and drops the rest — say so rather than
			// reporting ✔ over a silent partial read (the decision-156 failure shape)
			if (bothLayouts(source.root, kind)) {
				console.warn(`⚠ module ${source.name}: both ${kind}/ and system/${kind}/ exist — the flat copy wins and system/${kind}/ is NOT compiled. finish the move.`);
			}
			const srcDir = kindDir(source.root, kind);
			if (!fs.existsSync(srcDir)) continue;
			counts[kind] ??= 0;
			for (const name of fs.readdirSync(srcDir).sort()) {
				if (name.startsWith('.')) continue;
				const entityId = name.replace(/\.[^.]+\.(yaml|md|json)$/, '');
				if (disabled.has(`${source.name}/${entityId}`)) { disabledHits.add(`${source.name}/${entityId}`); continue; }
				const srcPath = path.join(srcDir, name);
				const isDir = fs.statSync(srcPath).isDirectory();
				if (kind === 'collections' && !isDir) {
					// descriptors merge via 'extends' — collect per collection name
					const bytes = fs.readFileSync(srcPath);
					const doc = load(bytes.toString('utf8'));
					if (!doc.name || (!doc.schema && !doc.extends)) fail(`${rel(srcPath)}: descriptor needs 'name' and 'schema' (or 'extends')`);
					if (!descriptorGroups.has(doc.name)) descriptorGroups.set(doc.name, []);
					descriptorGroups.get(doc.name).push({ src: { path: rel(srcPath), hash: sha256(bytes) }, doc, moduleName: source.name });
					contributed.add(source.name);
				} else if (FOLDER_KINDS.has(kind) && isDir) {
					for (const file of walk(srcPath)) {
						addEntry(path.join(kind, name, path.relative(srcPath, file)), file);
						contributed.add(source.name);
					}
					counts[kind]++;
				} else if (!isDir) {
					addEntry(path.join(kind, name), srcPath);
					contributed.add(source.name);
					counts[kind]++;
				} else {
					// nested dirs for file-shape kinds (e.g. date-partitioned) — recurse
					for (const file of walk(srcPath)) {
						addEntry(path.join(kind, path.relative(srcDir, file)), file);
						contributed.add(source.name);
						counts[kind]++;
					}
				}
			}
		}
	}

	// A module that ships only folders the engine does not recognise compiles ✔ and contributes
	// NOTHING. Warn; do not fail, since a module that is temporarily source-free is the
	// operator's business, not the compiler's.
	for (const source of sources) {
		if (contributed.has(source.name)) continue;
		console.warn(`⚠ module "${source.name}" (${rel(source.root)}) contributed no recognised sources — its folder names must match a known kind (${KINDS.join(', ')})`);
	}

	// ---- stage module UI bundles ---------------------------------------------------
	// modules ship a PRE-BUILT app.js that registers components/layouts against the studio
	// registry (design "the UI": components are module code, never records). staged under
	// .dreamteamer/ui/<module>/app.js; the server serves /ui, the studio imports and calls it.
	// studio/dist/app.js (a built bundle) wins over studio/app.js (plain-JS, host-provided Vue).
	const uiModules = [];
	const uiOwners = new Map(); // shortName -> module name, for a readable collision error
	for (const source of sources) {
		const cand = ['studio/dist/app.js', 'studio/app.js']
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
	}

	// ---- collection-templates, for `templates:` merging ----------------------------
	// A template is a live, shared field set — not the copy-once scaffold `collections add
	// --template` used to stamp out. A descriptor declaring `templates: [collection-templates/x]`
	// gets x's `template:` merged in BEFORE base/extender discrimination, with precedence
	// template < base < overlay. (The key is `templates:`, not `extends:` — `extends:` already
	// means "this descriptor overlays another module's collection of the same name".)
	const templateDocs = new Map();     // id -> { template, src }
	for (const [rt, entry] of entries) {
		const m = /^collection-templates\/(.+)\.collection-template\.yaml$/.exec(rt);
		if (!m) continue;
		const doc = load(entry.bytes.toString('utf8'));
		templateDocs.set(m[1], { template: doc.template ?? {}, src: entry.sources[0] });
	}

	// ---- resolve descriptor groups (templates + extends merge) ---------------------
	counts.collections = 0;
	let mergedCount = 0;
	let templatedCount = 0;
	for (const [name, group] of descriptorGroups) {
		// a template's bytes feed the compiled descriptor, so it MUST be one of that descriptor's
		// declared sources — otherwise editing the template leaves every consumer silently stale
		// and `warnIfStale` has nothing to compare against.
		const templateSources = [];
		for (const g of group) {
			const decl = g.doc.templates;
			if (decl === undefined) continue;
			if (!Array.isArray(decl)) fail(`${g.src.path}: 'templates' must be a list of collection-templates/<id> refs`);
			for (const ref of decl) {
				const id = String(ref).replace(/^collection-templates\//, '');
				const t = templateDocs.get(id);
				if (!t) fail(`${g.src.path}: templates references "${ref}" — no such collection-template (have: ${[...templateDocs.keys()].join(', ') || 'none'})`);
				g.doc = applyTemplate(g.doc, t.template);
				templateSources.push(t.src);
				templatedCount++;
			}
			delete g.doc.templates;
		}

		const bases = group.filter((g) => !g.doc.extends);
		const extenders = group.filter((g) => g.doc.extends);
		if (bases.length === 0) fail(`collection "${name}": every descriptor declares 'extends' — no base found (${group.map((g) => g.src.path).join(', ')})`);
		if (bases.length > 1) fail(`name collision on collection "${name}"\n${bases.map((b) => `    - ${b.src.path}`).join('\n')}\n  same-name descriptors must declare 'extends: <module>/<collection>'.`);
		const base = bases[0];
		let merged = structuredClone(base.doc);
		for (const ext of extenders) {
			const expected = `${base.moduleName}/${name}`;
			if (ext.doc.extends !== expected) {
				fail(`${ext.src.path}: extends "${ext.doc.extends}" does not name the base "${expected}"`);
			}
			merged = mergeDescriptor(merged, ext.doc);
		}
		delete merged.extends;
		// ---- resolved storage: the path, the owning repo, and which root it hangs off ---
		// The three facts the record layer needs stated as DATA, so it never has to re-derive
		// them from the shape of a path (see runtime.js). `storage.path` stays root-relative;
		// `storage.repo` is read by the git layer alone; `storage.base` says WHICH root — and
		// this is the only place that decides it.
		//
		// A runtime-based collection's storage path IS a kind folder (`skills`), so an exact KINDS
		// match is the test. It used to be a `system/` prefix check, which the flatten silently
		// inverted: every one of the seven would have compiled as `base: workspace`, resolved under
		// the workspace root, read as zero records, and become writable through the store.
		merged.storage ??= {};
		const owned = dataOwners.get(storageOwnerOf(group, base));
		const storagePath = String(merged.storage.path ?? '');
		const isSystem = KINDS.includes(storagePath) || KINDS.includes(storagePath.replace(/^system\//, ''));
		merged.storage.base = isSystem ? 'runtime' : 'workspace';
		if (owned && !isSystem) {
			const modRel = rel(owned.root);
			merged.storage.path = modRel ? `${modRel}/${merged.storage.path}` : merged.storage.path;
			merged.storage.repo = repoRootOf(owned.root, root);
		} else {
			merged.storage.repo = '.';
		}
		// the merged schema must itself be a compilable JSON Schema — a malformed property
		// (e.g. a string where an object belongs) used to pass compile and detonate at the
		// first record validation. caught HERE so the schema-ops dry-run gate is airtight.
		try {
			descriptorAjv().compile(structuredClone(merged.schema));
		} catch (e) {
			fail(`collection "${name}": schema is not a valid JSON Schema — ${e.message} (${group.map((g) => g.src.path).join(', ')})`);
		}
		// ---- resolved labels: what to CALL this collection, its records and its fields --------
		// Written into the artifact next to `storage.base` and for the same reason: the nav, the
		// browse page, the CLI and the extension then read ONE field instead of each carrying its
		// own title-caser. Authored values always win — `??=` never overwrites. After the ajv gate
		// on purpose: a malformed property must fail as a bad schema, not as a TypeError here.
		merged.title ??= titleCase(name);
		const labelProps = merged.schema?.properties ?? {};
		// how a RECORD of this collection is labelled — the probe presentation.js has always used
		// for `meta.title_field`, promoted to an authorable field. Reference fields pointing here
		// inherit it (presentation.js), which is what replaces 51 hand-written `x-display` lines.
		merged.title_template ??= `{{ ${['title', 'name', 'subject'].find((f) => f in labelProps) ?? 'id'} }}`;
		for (const [fieldName, prop] of Object.entries(labelProps)) {
			if (prop && typeof prop === 'object' && !Array.isArray(prop)) prop.title ??= titleCase(fieldName);
		}
		const rt = path.join('collections', `${name}.collection.yaml`);
		entries.set(rt, { sources: [...group.map((g) => g.src), ...templateSources], bytes: Buffer.from(dump(merged)) });
		counts.collections++;
		if (extenders.length) mergedCount++;
	}

	// ---- unresolved references are compile errors (an agent's declared skills)
	const skillIds = new Set([...entries.keys()].filter((k) => k.startsWith('skills/')).map((k) => k.split('/')[1]));
	for (const [rt, e] of entries) {
		if (rt.startsWith('agents/')) {
			const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(e.bytes.toString('utf8'));
			const doc = fm ? load(fm[1]) : {};
			for (const sk of doc.skills ?? []) {
				if (!skillIds.has(String(sk).replace(/^skills\//, ''))) fail(`${rt}: references unknown skill "${sk}"`);
			}
		}
	}
	if (disabledHits.size < disabled.size) {
		for (const d of disabled) if (!disabledHits.has(d)) console.warn(`⚠ dreamteamer.disable entry "${d}" matched nothing`);
	}

	// ---- ui-view layout validation --------------------------------------------------
	// layouts are registered module code; a view naming an unregistered layout fails loudly
	// naming the registered set (design guardrail: "unknown layout = compile error").
	// core set = the studio's built-ins; modules declare theirs in package.json
	// dreamteamer.studio.layouts (the same file their app.js registration lives beside).
	// KEEP IN SYNC with the UI's `lists.register(...)` calls (dreamteamer-vscode
	// webview/src/registry/register-defaults.ts). kanban/calendar/map landed there as core Lists in
	// the 2026-07-27 layouts wave but this set was never widened, so the only way to get a
	// `layout: kanban` view past compile was for a module to CLAIM the layout it didn't own — which
	// is what a workspace module was once caught doing, shadowing the core board in the registry (a
	// module's app.js loads after the built-ins and Map.set wins). Fixed both ends 2026-07-29.
	const registeredLayouts = new Set(['table', 'cards', 'kanban', 'calendar', 'map']);
	for (const source of sources) {
		try {
			const mpkg = JSON.parse(fs.readFileSync(path.join(source.root, 'package.json'), 'utf8'));
			for (const l of mpkg.dreamteamer?.studio?.layouts ?? []) registeredLayouts.add(l);
		} catch { /* root-workspace source without package.json */ }
	}
	for (const [rt, e] of entries) {
		if (!rt.startsWith('ui-views/')) continue;
		const view = load(e.bytes.toString('utf8'));
		if (view?.target === 'list' && view?.layout && !registeredLayouts.has(view.layout)) {
			fail(`${rt}: layout "${view.layout}" is not registered (registered: ${[...registeredLayouts].sort().join(', ')}).\n  a module registers layouts in its studio app.js AND declares them in package.json under dreamteamer.studio.layouts.`);
		}
		// filters are load-bearing (they narrow what the operator SEES) — typo'd operators
		// fail at compile, not silently at render (review finding 5)
		const badOps = view?.filter ? [...unknownOperators(view.filter)] : [];
		if (badOps.length) fail(`${rt}: unknown filter operator(s) ${badOps.join(', ')}`);
	}

	// ---- command-binding validation --------------------------------------------------
	// a binding joins a command to a collection under can-enter/can-exit predicates;
	// dangling refs and typo'd operators fail HERE, not silently at evaluation (the same
	// guarantee ui-view filters get — validators are load-bearing, they gate what runs).
	const commandIds = new Set([...entries.keys()].filter((k) => k.startsWith('commands/')).map((k) => path.basename(k).replace(/\.command\.md$/, '')));
	for (const [rt, e] of entries) {
		if (!rt.startsWith('command-bindings/')) continue;
		const b = load(e.bytes.toString('utf8'));
		const cmd = String(b?.command ?? '').replace(/^commands\//, '');
		if (!cmd || !commandIds.has(cmd)) fail(`${rt}: references unknown command "${b?.command ?? ''}"`);
		const coll = String(b?.collection ?? '').replace(/^collections\//, '');
		if (!coll || !descriptorGroups.has(coll)) fail(`${rt}: references unknown collection "${b?.collection ?? ''}"`);
		for (const key of ['can-enter', 'can-exit']) {
			const badBindOps = b?.[key] ? [...unknownOperators(b[key])] : [];
			if (badBindOps.length) fail(`${rt}: ${key} has unknown filter operator(s) ${badBindOps.join(', ')}`);
			if (b?.[key] && b?.target === 'collection') console.warn(`⚠ ${rt}: ${key} is ignored — target=collection bindings evaluate no record`);
		}
	}

	// ---- materialize .dreamteamer ------------------------------------------------
	// mkdir the runtime ROOT unconditionally: with zero entries nothing below created it, so the
	// manifest write at the end failed ENOENT — `init` followed by `compile` in a fresh workspace
	// crashed on the one path a new user takes first.
	fs.mkdirSync(RUNTIME, { recursive: true });
	// clear each kind's folder, plus `system/` — a runtime compiled by a pre-flatten engine has the
	// whole tree under there, and leaving it would keep stale descriptors on disk beside the fresh
	// ones. Never `rm -rf` the runtime root itself: it also holds the write lock.
	for (const kind of KINDS) fs.rmSync(path.join(RUNTIME, kind), { recursive: true, force: true });
	fs.rmSync(path.join(RUNTIME, 'system'), { recursive: true, force: true });
	fs.rmSync(path.join(RUNTIME, 'ui'), { recursive: true, force: true });
	for (const [rt, e] of entries) {
		const dest = path.join(RUNTIME, rt);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, e.bytes);
	}

	// ---- harness adapters (dispatch table lives in harnesses.js) -------------------
	const prevManifest = readManifest(root);
	// What the harness blocks should TELL an agent about where sources live — measured, not assumed.
	// A workspace still on the nested layout was being handed prose naming the flat one, and that
	// block is the first thing a session reads.
	const anyFlat = sources.some((s) => KINDS.some((k) => fs.existsSync(path.join(s.root, k))));
	const anyNested = sources.some((s) => KINDS.some((k) => fs.existsSync(path.join(s.root, 'system', k))));
	const sourceLayout = anyFlat && anyNested ? 'mixed' : anyNested ? 'nested' : 'flat';
	const { outputs: adapterOutputs, summary: harnessSummary } = runHarnessAdapters({ root, entries, harnesses, prevManifest, sourceLayout });

	// ---- provenance manifest ------------------------------------------------------
	const manifest = {
		compiled: new Date().toISOString(),
		host: engineId(),
		modules: sources.map((s) => ({ name: s.name, channel: s.channel, root: rel(s.root) || '.' })),
		ui: uiModules.sort(),
		'adapter-outputs': adapterOutputs.sort(),
		entries: Object.fromEntries(
			[...entries].map(([rt, e]) => [rt, { sources: e.sources, hash: sha256(e.bytes) }]) // sources: [{path, hash}] — per-SOURCE hashes power staleness
		),
	};
	fs.writeFileSync(path.join(RUNTIME, 'manifest.yaml'), dump(manifest));

	const summary = KINDS.filter((k) => counts[k]).map((k) => `${counts[k]} ${k}${k === 'collections' && mergedCount ? ` (${mergedCount} merged)` : ''}`).join(', ');
	const sourceLabel = config['workspace-module']
		? `${sources.length} module(s) (workspace-module: ${config['workspace-module']})`
		: `${sources.length - 1} module(s) + workspace`;
	console.log(`✔ compiled ${summary || 'nothing'} from ${sourceLabel} → .dreamteamer`);
	for (const line of harnessSummary) console.log(`✔ harness ${line}`);
	return 0;
}

function engineId() {
	try {
		const p = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
		return `${p.name}@${p.version}`;
	} catch { return 'dreamteamer@unknown'; }
}

// bare version of the RUNNING engine (dev clone or installed copy — whichever loaded)
export function engineVersion() {
	return engineId().split('@').pop();
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
	const known = new Set(Object.values(manifest.entries ?? {}).flatMap((e) => e.sources.map((s) => (typeof s === 'string' ? s : s.path))));
	let pkg = {};
	try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { /* no pkg */ }
	const wm = pkg.dreamteamer?.['workspace-module'];
	const roots = [...(wm ? [] : [root]), ...discoverModules(root, pkg).modules.map((m) => m.root)];
	for (const r of roots) {
		for (const kind of KINDS) {
			const dir = kindDir(r, kind);
			if (!fs.existsSync(dir)) continue;
			for (const f of walk(dir)) {
				const relPath = path.relative(root, f);
				if (!known.has(relPath)) stale.push(`${relPath} (new, uncompiled)`);
			}
		}
	}
	return { compiled: true, stale, manifest };
}

export function warnIfStale(root) {
	const s = staleness(root);
	if (!s.compiled) console.warn(`⚠ ${s.message}`);
	else if (s.stale.length) console.warn(`⚠ .dreamteamer is stale (${s.stale.length} source(s) differ) — run \`dreamteamer compile\``);
	return s;
}


// `templates:` merge — the DESCRIPTOR always wins, and its own key order is preserved (unlike
// mergeDescriptor, whose extender wins). Two properties of this that matter:
//
//   - the descriptor keeps `extends` and `name`: losing `extends` would silently demote an overlay
//     to a second base and collide with the real one.
//   - template-added properties are inserted BEFORE the x-body property, not appended after it.
//     Property order is form order in the studio, and the record's body belongs last — metadata
//     about a record should not render below the record's content.
function applyTemplate(doc, tpl) {
	const out = structuredClone(doc);
	for (const [k, v] of Object.entries(tpl)) {
		if (k === 'schema') continue;
		if (out[k] === undefined) out[k] = structuredClone(v);
	}
	if (!tpl.schema) return out;
	out.schema ??= { type: 'object' };
	for (const [sk, sv] of Object.entries(tpl.schema)) {
		if (sk === 'properties') {
			const own = out.schema.properties ?? {};
			const add = Object.entries(sv).filter(([pk]) => own[pk] === undefined);
			const bodyKey = Object.entries(own).find(([, s]) => s?.['x-body'])?.[0];
			const merged = {};
			for (const [pk, pv] of Object.entries(own)) {
				if (pk === bodyKey) for (const [ak, av] of add) merged[ak] = structuredClone(av);
				merged[pk] = pv;
			}
			if (!bodyKey) for (const [ak, av] of add) merged[ak] = structuredClone(av);
			out.schema.properties = merged;
		} else if (sk === 'required') {
			out.schema.required = [...new Set([...(out.schema.required ?? []), ...sv])];
		} else if (out.schema[sk] === undefined) out.schema[sk] = sv;
	}
	return out;
}

/** Which module supplied the descriptor's WINNING storage block. mergeDescriptor lets an
 *  extender win on any non-schema key (`else out[k] = v`), so "storage comes from the base" is
 *  the default, not a guarantee — an overlay that declares its own storage overrides it, and
 *  ownership must follow the block that actually survived. */
function storageOwnerOf(group, base) {
	let owner = base.moduleName;
	for (const g of group) if (g.doc.extends && g.doc.storage) owner = g.moduleName;
	return owner;
}

// extends merge: schema.properties merge per-property, required unions, other
// keys extender-wins; storage/id come from the base unless explicitly overridden.
function mergeDescriptor(base, ext) {
	const out = structuredClone(base);
	for (const [k, v] of Object.entries(ext)) {
		if (k === 'extends' || k === 'name') continue;
		if (k === 'schema') {
			out.schema ??= { type: 'object', properties: {} };
			for (const [sk, sv] of Object.entries(v)) {
				if (sk === 'properties') out.schema.properties = { ...out.schema.properties, ...sv };
				else if (sk === 'required') out.schema.required = [...new Set([...(out.schema.required ?? []), ...sv])];
				else out.schema[sk] = sv;
			}
		} else out[k] = v;
	}
	return out;
}

// a bad source THROWS (review finding 8: process.exit killed --watch on the first typo
// and made server-triggered recompiles impossible). the CLI boundary prints and exits.
export class CompileError extends Error {}

let _descriptorAjv = null;
function descriptorAjv() {
	if (!_descriptorAjv) {
		_descriptorAjv = new Ajv({ allErrors: true, strict: false });
		addFormats(_descriptorAjv);
		_descriptorAjv.addFormat('markdown', true);
	}
	return _descriptorAjv;
}

function fail(msg) {
	throw new CompileError(`compile error: ${msg}`);
}
