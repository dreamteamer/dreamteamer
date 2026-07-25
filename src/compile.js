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
import { runHarnessAdapters } from './harnesses.js';

export const KINDS = ['collections', 'skills', 'agents', 'commands', 'workflows', 'ui-views', 'collection-templates'];
const FOLDER_KINDS = new Set(['skills']); // folder-shape entities: copy the whole record folder

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

export function shadowWarning({ name, winner, loser }) {
	return `⚠ module ${name}: ${CHANNEL_LABEL[winner]} copy shadows ${CHANNEL_LABEL[loser]} copy`;
}

export function compile({ root, pkg }) {
	const RUNTIME = path.join(root, '.dreamteamer');
	const config = pkg.dreamteamer ?? {};
	const harnesses = config.harnesses ?? ['claude-code'];
	const rel = (p) => path.relative(root, p);

	// ---- discover sources: channel modules then workspace system/ ------------------
	const { modules: discovered, shadows } = discoverModules(root, pkg);
	for (const s of shadows) console.warn(shadowWarning(s));
	const sources = [...discovered];
	// workspace-owned sources: either the root system/ (classic layout) or the
	// designated workspace module under modules/ (config `workspace-module` —
	// "the workspace is itself a module", made literal). when the key is set the
	// root system/ is NOT read, so the two layouts can never fork.
	if (!config['workspace-module']) {
		sources.push({ name: pkg.name, root, channel: 'inline' });
	} else if (fs.existsSync(path.join(root, 'system')) && [...walk(path.join(root, 'system'))].length) {
		fail(`root system/ contains sources but workspace-module="${config['workspace-module']}" is set — they would be silently ignored.\n  move them into modules/${config['workspace-module']}/system/ (decision 22).`);
	}

	const disabled = new Set(config.disable ?? []);
	const disabledHits = new Set();

	/** entries: runtime-relative path -> { sources: [workspace-relative], bytes } */
	const entries = new Map();
	const counts = {};
	/** collection descriptors collected per name for extends-merging: name -> [{src, doc, moduleName}] */
	const descriptorGroups = new Map();

	function addEntry(runtimePath, srcPath) {
		if (entries.has(runtimePath)) {
			const [, kind, entity] = /^system\/([^/]+)\/([^/]+)/.exec(runtimePath) ?? [];
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

	for (const source of sources) {
		for (const kind of KINDS) {
			const srcDir = path.join(source.root, 'system', kind);
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
				} else if (FOLDER_KINDS.has(kind) && isDir) {
					for (const file of walk(srcPath)) {
						addEntry(path.join('system', kind, name, path.relative(srcPath, file)), file);
					}
					counts[kind]++;
				} else if (!isDir) {
					addEntry(path.join('system', kind, name), srcPath);
					counts[kind]++;
				} else {
					// nested dirs for file-shape kinds (e.g. date-partitioned) — recurse
					for (const file of walk(srcPath)) {
						addEntry(path.join('system', kind, path.relative(srcDir, file)), file);
						counts[kind]++;
					}
				}
			}
		}
	}

	// ---- stage module UI bundles ---------------------------------------------------
	// modules ship a PRE-BUILT app.js that registers components/layouts against the studio
	// registry (design "the UI": components are module code, never records). staged under
	// .dreamteamer/ui/<module>/app.js; the server serves /ui, the studio imports and calls it.
	// studio/dist/app.js (a built bundle) wins over studio/app.js (plain-JS, host-provided Vue).
	const uiModules = [];
	for (const source of sources) {
		const cand = ['studio/dist/app.js', 'studio/app.js']
			.map((p) => path.join(source.root, p))
			.find((p) => fs.existsSync(p));
		if (!cand) continue;
		const shortName = source.name.split('/').pop();
		addEntry(path.join('ui', shortName, 'app.js'), cand);
		uiModules.push(shortName);
	}

	// ---- resolve descriptor groups (extends merge) --------------------------------
	counts.collections = 0;
	let mergedCount = 0;
	for (const [name, group] of descriptorGroups) {
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
		// the merged schema must itself be a compilable JSON Schema — a malformed property
		// (e.g. a string where an object belongs) used to pass compile and detonate at the
		// first record validation. caught HERE so the schema-ops dry-run gate is airtight.
		try {
			descriptorAjv().compile(structuredClone(merged.schema));
		} catch (e) {
			fail(`collection "${name}": schema is not a valid JSON Schema — ${e.message} (${group.map((g) => g.src.path).join(', ')})`);
		}
		const rt = path.join('system', 'collections', `${name}.collection.yaml`);
		entries.set(rt, { sources: group.map((g) => g.src), bytes: Buffer.from(dump(merged)) });
		counts.collections++;
		if (extenders.length) mergedCount++;
	}

	// ---- unresolved references are compile errors (workflow operators, agent skills)
	const skillIds = new Set([...entries.keys()].filter((k) => k.startsWith('system/skills/')).map((k) => k.split('/')[2]));
	const agentIds = new Set([...entries.keys()].filter((k) => k.startsWith('system/agents/')).map((k) => path.basename(k).replace(/\.agent\.md$/, '')));
	for (const [rt, e] of entries) {
		if (rt.startsWith('system/workflows/')) {
			const wf = load(e.bytes.toString('utf8'));
			for (const step of wf.steps ?? []) {
				const a = step.operator?.agent;
				if (a && !agentIds.has(a.replace(/^agents\//, ''))) fail(`${rt}: step "${step.id}" references unknown agent "${a}"`);
				for (const sk of step.operator?.skills ?? []) {
					if (!skillIds.has(sk.replace(/^skills\//, ''))) fail(`${rt}: step "${step.id}" references unknown skill "${sk}"`);
				}
			}
		} else if (rt.startsWith('system/agents/')) {
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
	const registeredLayouts = new Set(['table', 'cards']);
	for (const source of sources) {
		try {
			const mpkg = JSON.parse(fs.readFileSync(path.join(source.root, 'package.json'), 'utf8'));
			for (const l of mpkg.dreamteamer?.studio?.layouts ?? []) registeredLayouts.add(l);
		} catch { /* root-workspace source without package.json */ }
	}
	for (const [rt, e] of entries) {
		if (!rt.startsWith('system/ui-views/')) continue;
		const view = load(e.bytes.toString('utf8'));
		if (view?.target === 'list' && view?.layout && !registeredLayouts.has(view.layout)) {
			fail(`${rt}: layout "${view.layout}" is not registered (registered: ${[...registeredLayouts].sort().join(', ')}).\n  a module registers layouts in its studio app.js AND declares them in package.json under dreamteamer.studio.layouts.`);
		}
	}

	// ---- materialize .dreamteamer ------------------------------------------------
	fs.rmSync(path.join(RUNTIME, 'system'), { recursive: true, force: true });
	fs.rmSync(path.join(RUNTIME, 'ui'), { recursive: true, force: true });
	for (const [rt, e] of entries) {
		const dest = path.join(RUNTIME, rt);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, e.bytes);
	}

	// ---- harness adapters (dispatch table lives in harnesses.js) -------------------
	const prevManifest = readManifest(root);
	const { outputs: adapterOutputs, summary: harnessSummary } = runHarnessAdapters({ root, entries, harnesses, prevManifest });

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

export function readManifest(root) {
	try { return load(fs.readFileSync(path.join(root, '.dreamteamer', 'manifest.yaml'), 'utf8')); } catch { return null; }
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
			const dir = path.join(r, 'system', kind);
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
