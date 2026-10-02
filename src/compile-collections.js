// Compiling collection descriptors — descriptor format v2, the only format the engine reads.
//
// Input: every collection source a module ships, grouped by collection name, plus the mixins and the
// module graph compile has already established. Output: one compiled descriptor per collection —
// the authored keys (mixins and overlays merged in), and a `compiled` block holding everything
// compile decided: the defaults it supplied, the module, the repo, whether the records are build
// output, the parent a placed collection lives under, the mirrors, the overlaying modules, the peers
// nothing installed provides, the resolved `fields` every reader asks through src/descriptor.js, and
// the `json_schema` the validator runs.
//
// A v1 source — a descriptor without `fields`, or a collection-template — is refused, all of them in
// one message naming the converter. Nothing here reads the v1 shape.
import path from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { shapeErrors, mergeMixins, mergeOverlays, nameErrors, isV2 } from './descriptor-v2.js';
import { resolveFields, toJsonSchema } from './fields.js';
import { targetsOf } from './descriptor.js';
import { defaultStoragePath, baseNameOf, singular, inflects, namespaceOf, storageOverlaps } from './namespace.js';
import { subpathProblem } from './placement.js';
import { patternRe } from './records.js';

export const CONVERTER = 'node node_modules/dreamteamer/scripts/migrate-descriptors-v2.mjs --root .';

/** The one refusal for a workspace that still holds v1 sources, listing every file. */
export function v1Refusal(files) {
	return `${files.length} source(s) are in the v1 descriptor format, which this engine no longer reads:\n${files.map((f) => `    - ${f}`).join('\n')}\n  convert the workspace once: ${CONVERTER}\n  then dt compile and dt check — UPDATING.md has the walk.`;
}

let ajv = null;
const schemaAjv = () => {
	if (!ajv) { ajv = new Ajv({ allErrors: true, strict: false }); addFormats(ajv); ajv.addFormat('markdown', true); }
	return ajv;
};

const titleCase = (id) => String(id).split(/[_\-\s/]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/**
 * @param {object} ctx
 * @param {Map<string, {src, doc, moduleName}[]>} ctx.groups   collection name -> its sources
 * @param {Map<string, object>} ctx.mixins                       mixin id -> doc (with `src`)
 * @param {string[]} ctx.namespaces
 * @param {Map<string,string>} ctx.nsOwners                      namespace -> module name
 * @param {Set<string>} ctx.runtimeKinds                         storage paths that are build output
 * @param {Set<string>} ctx.core                                 collections every module may reference
 * @param {Map<string,string[]>} ctx.moduleDeps
 * @param {Map<string,string[]>} ctx.modulePeers
 * @param {Map<string,string>} ctx.channelOf                     module name -> inline | git | npm
 * @param {string} ctx.wsModuleName
 * @param {string} ctx.engineName
 * @param {Map<string,{root}>} ctx.dataOwners                    owns-data modules
 * @param {(moduleRoot: string) => string} ctx.repoOf            workspace-relative git repo of a module root
 * @param {(p: string) => string} ctx.rel
 * @param {string} ctx.dataPath
 * @param {(n: string) => string} ctx.moduleId
 * @param {(msg: string) => never} ctx.fail
 * @param {(msg: string) => void} ctx.warn
 * @returns {{ compiled: Map<string, {doc, sources}>, inert: {path, hash}[], moduleColls: Map<string, Set<string>> }}
 */
export function compileCollections(ctx) {
	const { groups, mixins, namespaces, nsOwners, runtimeKinds, core, moduleDeps, modulePeers, channelOf, wsModuleName, engineName, dataOwners, repoOf, dataPath, moduleId, fail, warn } = ctx;

	// ---- v1 is refused, every file at once --------------------------------------------------
	const v1 = [];
	for (const group of groups.values()) for (const g of group) if (!isV2(g.doc)) v1.push(g.src.path);
	if (v1.length) fail(v1Refusal(v1.sort()));

	const typeNames = new Set([...groups.keys(), ...core]);
	const allPeers = new Set([...modulePeers.values()].flat());
	const out = new Map();
	const inert = [];
	const moduleColls = new Map();
	const owners = new Map(); // collection -> owning module name

	// ---- per collection: bases, overlays, mixins, fields -------------------------------------
	const staged = new Map(); // name -> { authored, group, base, overlays, mixinSrcs }
	for (const [name, group] of groups) {
		const bases = group.filter((g) => g.doc.overlay !== true);
		const overlays = group.filter((g) => g.doc.overlay === true);
		const where = group.map((g) => g.src.path).join(', ');
		// An overlay of a collection its module declares as a PEER applies while that collection is
		// installed and is inert while it is not. Its sources are still sources: they are recorded so
		// `dt status` does not call the workspace stale over them.
		if (!bases.length && overlays.every((g) => (modulePeers.get(g.moduleName) ?? []).includes(name))) {
			inert.push(...group.map((g) => g.src));
			continue;
		}
		if (!bases.length) fail(`collection "${name}": every source declares \`overlay: true\` — no base found (${where}). Install the module that owns it, or declare "${name}" in this module's peer_collections so the overlay applies only while it is installed.`);
		if (bases.length > 1) fail(`name collision on collection "${name}"\n${bases.map((b) => `    - ${b.src.path}`).join('\n')}\n  a second source of one collection must declare \`overlay: true\`.`);
		const base = bases[0];
		owners.set(name, base.moduleName);
		for (const o of overlays) {
			if (o.moduleName === base.moduleName) continue;
			const depends = (moduleDeps.get(o.moduleName) ?? []).includes(base.moduleName);
			const peer = (modulePeers.get(o.moduleName) ?? []).includes(name);
			if (!depends && !peer) fail(`${o.src.path}: an overlay of "${name}", but module "${o.moduleName}" neither depends on "${base.moduleName}" nor declares "${name}" in peer_collections — an overlay cannot compile without its base.`);
		}
		const mixed = new Map();
		const mixinSrcs = [];
		for (const g of group) {
			const shape = shapeErrors(g.doc);
			if (shape.length) fail(`${g.src.path}:\n  ${shape.join('\n  ')}`);
			const { doc, errors, used } = mergeMixins(g.doc, mixins);
			if (errors.length) fail(`${g.src.path}:\n  ${errors.join('\n  ')}`);
			mixinSrcs.push(...used.map((id) => mixins.get(id).src));
			mixed.set(g, doc);
		}
		const authored = mergeOverlays(mixed.get(base), overlays.map((g) => mixed.get(g)));
		const names = nameErrors(authored);
		if (names.length) fail(`collection "${name}" (${where}):\n  ${names.join('\n  ')}`);
		staged.set(name, { authored, group, base, overlays, mixinSrcs, where });
	}

	// ---- storage, fields, the reference contract ----------------------------------------------
	const storageEntries = [];
	const wordEntries = [];
	for (const [name, s] of staged) {
		const { authored, group, base, overlays, where } = s;
		const a = authored.storage ?? {};
		const owned = dataOwners.get(base.moduleName);
		let storagePath = a.path ?? defaultStoragePath(name, namespaces, dataPath);
		const runtime = runtimeKinds.has(storagePath);
		let repo = '.';
		if (owned && !runtime) {
			const modRel = ctx.rel(owned.root);
			if (modRel) storagePath = `${modRel}/${storagePath}`;
			repo = repoOf(owned.root);
		}
		const bare = baseNameOf(name, namespaces);
		const sdefaults = {};
		if (a.path === undefined || storagePath !== a.path) sdefaults.path = storagePath;
		if (a.format === undefined) sdefaults.format = 'md';
		if (a.shape === undefined) sdefaults.shape = 'file';
		if (a.suffix === undefined) sdefaults.suffix = singular(bare);
		const format = a.format ?? 'md';
		if (format === 'binary' && (a.shape ?? 'file') === 'folder') fail(`collection "${name}" is \`format: binary\` — one file per record, not a folder; drop \`shape: folder\` (${where})`);
		storageEntries.push({ name, path: storagePath, base: runtime ? 'runtime' : 'workspace' });

		// an opaque record's fields are the ones derived from the file itself
		const fields = { ...(authored.fields ?? {}) };
		if (format === 'binary') {
			fields.ext ??= { type: 'string', virtual: true, description: "The file's extension, lowercase and without the dot. Read from the file." };
			fields.bytes ??= { type: 'integer', virtual: true, description: "The file's size in bytes. Read from the file." };
		}
		const { fields: resolved, errors, warnings, defaults: fieldDefaults } = resolveFields(fields, { name, collections: typeNames, peers: allPeers, runtime });
		if (errors.length) fail(`collection "${name}" (${where}):\n  ${errors.join('\n  ')}`);
		for (const w of warnings) warn(`⚠ collection ${name}: ${w}`);
		const constraints = authored.constraints ?? [];
		const jsonSchema = toJsonSchema(resolved, { constraints, collections: typeNames });
		try { schemaAjv().compile(structuredClone(jsonSchema)); }
		catch (e) { fail(`collection "${name}": its fields and constraints do not make a valid JSON Schema — ${e.message} (${where})`); }
		if (authored.ids?.pattern !== undefined) {
			if (typeof authored.ids.pattern !== 'string') fail(`collection "${name}": ids.pattern must be a string (${where})`);
			try { patternRe(authored.ids.pattern); } catch (e) { fail(`collection "${name}": ids.pattern is not a valid regular expression — ${e.message} (${where})`); }
		}

		// who owns it, who overlays it, and the namespace it sits in
		const groupModules = [...new Set(group.map((g) => g.moduleName))];
		const ownerId = moduleId(base.moduleName);
		if (authored.internal === true && ![engineName, wsModuleName].includes(base.moduleName)) {
			fail(`collection "${name}": \`internal: true\` is reserved for the engine's collections and the workspace module's — module ${ownerId} ships a domain collection (${where}).`);
		}
		const overlaidBy = [...new Set(overlays.map((o) => moduleId(o.moduleName)))].filter((m) => m !== ownerId).sort();
		const ns = namespaceOf(name, namespaces);
		const nsOwner = ns ? nsOwners.get(ns) : null;
		if (nsOwner && !groupModules.includes(nsOwner) && !groupModules.some((m) => (moduleDeps.get(m) ?? []).includes(nsOwner))) {
			fail(`collection "${name}" sits in namespace "${ns}", which module ${moduleId(nsOwner)} declares — ${groupModules.map(moduleId).join('/')} neither owns it nor depends on it.`);
		}
		for (const m of groupModules) {
			if (!moduleColls.has(m)) moduleColls.set(m, new Set());
			moduleColls.get(m).add(name);
		}

		// every target is owned, depended on, or declared a peer — judged per CONTRIBUTING source,
		// because the module that wrote a field is the one that must declare what it points at
		const referenced = new Set();
		for (const g of group) {
			const own = g.doc.fields ?? {};
			const mixFields = (g.doc.mixins ?? []).flatMap((id) => Object.entries(mixins.get(id)?.fields ?? {}));
			for (const [field, f] of [...Object.entries(own), ...mixFields]) {
				const targets = targetsOf(f);
				if (!targets) continue;
				if (targets === '*') {
					if (g.moduleName !== wsModuleName && (channelOf.get(g.moduleName) ?? 'inline') === 'inline') warn(`⚠ collection ${name}: field "${field}" is \`type: reference\` outside the workspace module — an unverifiable cross-module surface; name the collections it may target`);
					continue;
				}
				for (const t of targets) {
					referenced.add(t);
					if (core.has(t) || owners.get(t) === g.moduleName || groups.get(t)?.some((x) => x.moduleName === g.moduleName && x.doc.overlay !== true)) continue;
					const tOwner = owners.get(t);
					if (tOwner && (moduleDeps.get(g.moduleName) ?? []).includes(tOwner)) continue;
					if ((modulePeers.get(g.moduleName) ?? []).includes(t)) continue;
					if (g.moduleName === wsModuleName && tOwner) continue;
					fail(`collection "${name}": field "${field}" (${g.src.path}) references "${t}", which module ${g.moduleName} neither owns nor declares.\n  ${tOwner ? `add "${tOwner}" to dreamteamer.dependencies, or "${t}" to dreamteamer.peer_collections if the module should work without it` : `add "${t}" to dreamteamer.peer_collections — no installed module provides it`}.`);
				}
			}
		}
		const unresolved = [...referenced].filter((t) => !owners.has(t) && !core.has(t) && allPeers.has(t)).sort();

		// labels
		const title = authored.title ?? titleCase(bare);
		const singularWord = authored.singular ?? (ns ? `${ns}/${singular(bare)}` : singular(name));
		if (typeof singularWord !== 'string' || !singularWord.trim()) fail(`collection "${name}": \`singular\` must be a non-empty string`);
		wordEntries.push({ name, word: singularWord });
		if (authored.singular === undefined && !inflects(bare)) warn(`⚠ collection ${name}: "${bare}" is not a plural the inflector knows, so its singular is the name itself — set \`singular\` if \`dt add\` should take another word`);
		const probe = ['title', 'name', 'subject'].find((f) => resolved[f] && !resolved[f].virtual);
		const recordTitle = authored.record_title ?? `{{ ${probe ?? 'id'} }}`;

		if (!runtime && !String(authored.description ?? '').trim()) warn(`⚠ collection ${name} has no description — it renders as a bare name in the orientation block every session loads`);

		const defaults = {};
		if (authored.title === undefined) defaults.title = title;
		if (authored.singular === undefined) defaults.singular = singularWord;
		if (authored.record_title === undefined) defaults.record_title = recordTitle;
		if (Object.keys(sdefaults).length) defaults.storage = sdefaults;
		// the layouts a surface draws when the descriptor names none
		const ddefaults = {};
		if (authored.display?.list?.layout === undefined) ddefaults.list = { layout: 'table' };
		if (authored.display?.record?.layout === undefined) ddefaults.record = { layout: 'page' };
		defaults.display = ddefaults;
		if (Object.keys(fieldDefaults).length) defaults.fields = fieldDefaults;

		const doc = { ...authored };
		delete doc.mixins;
		delete doc.overlay;
		out.set(name, {
			doc,
			resolved,
			sources: [...group.map((g) => g.src), ...s.mixinSrcs],
			compiled: {
				defaults,
				module: ownerId,
				repo,
				runtime,
				mirrors: [],
				overlaid_by: overlaidBy,
				unresolved_peers: unresolved,
				fields: resolved,
				json_schema: jsonSchema,
			},
			storage: { path: storagePath, format, shape: a.shape ?? 'file', entry: a.entry, under: a.under, repo, runtime },
		});
	}

	for (const p of storageOverlaps(storageEntries)) fail(p);
	{
		const words = new Map();
		for (const { name } of wordEntries) words.set(name, name);
		for (const { name, word } of wordEntries) {
			if (word === name) continue;
			const other = words.get(word);
			if (other && other !== name) fail(`collections "${name}" and "${other}" both answer to the word "${word}" (a name or a singular) — author \`singular:\` on one of them so \`dt add ${word}\` names exactly one collection`);
			words.set(word, name);
		}
	}

	relations(out, fail);
	placement(out, fail);

	for (const [, c] of out) c.doc = { ...c.doc, compiled: c.compiled };
	return { compiled: out, inert, moduleColls };
}

/**
 * Relations, from the one spelling: a field `mirror_of: f` with `type: O` on collection T is the
 * generated mirror of O's reference field `f`. The owner must exist and point at T; a scalar mirror
 * means the owner's reference is unique; the target must be able to hold a generated field.
 */
function relations(out, fail) {
	for (const [tName, t] of out) {
		for (const [mName, m] of Object.entries(t.resolved)) {
			if (m.mirror_of === undefined) continue;
			const owner = targetsOf(m)[0];
			const o = out.get(owner);
			if (!o) continue; // an uninstalled peer: the mirror is inert until its owner is installed
			const f = o.resolved[m.mirror_of];
			const here = `${tName}.${mName}`, there = `${owner}.${m.mirror_of}`;
			if (!f) fail(`collection "${tName}": field "${mName}" is the mirror of ${there}, but ${owner} has no field "${m.mirror_of}".`);
			const ft = targetsOf(f);
			if (!ft || ft === '*' || !ft.includes(tName)) fail(`collection "${tName}": field "${mName}" is the mirror of ${there}, which does not reference ${tName}.`);
			if (!m.many && !(f.unique && !f.many)) fail(`collection "${tName}": field "${mName}" is a SCALAR mirror, so ${there} must be a unique scalar reference — declare \`unique: true\` on ${there}, or make ${here} \`many: true\`.`);
			if (m.many && f.unique && !f.many) fail(`collection "${tName}": ${there} is unique, so each ${tName} record has at most one — make ${here} scalar (drop \`many\`).`);
			if (f.on_delete === 'set-null' && f.many && (f.minItems ?? 0) > 1) fail(`collection "${owner}": field "${m.mirror_of}" declares minItems: ${f.minItems} — on_delete: set-null removes ONE entry per deleted record, so it would leave a list shorter than its own minimum. Use restrict, or drop minItems.`);
			if (t.storage.format === 'binary') fail(`collection "${tName}": field "${mName}" is a mirror, but ${tName}'s records are opaque files — there is no frontmatter to hold a generated field.`);
			if (t.storage.runtime) fail(`collection "${tName}": field "${mName}" is a mirror, but ${tName}'s records are compiled sources — the store would write into .dreamteamer/, which the next compile overwrites.`);
			if (t.storage.format === 'md' && !Object.values(t.resolved).some((x) => x.body)) fail(`collection "${tName}": field "${mName}" is a mirror, but ${tName} declares no body field — a mirror write would rebuild the file from its fields and erase any prose it holds. Declare one (\`notes: { type: markdown, body: true }\`).`);
			if (t.storage.repo !== o.storage.repo) fail(`collection "${tName}": field "${mName}" mirrors ${there} across two git repos — one commit cannot span them. Drop the mirror.`);
			t.compiled.mirrors.push(mName);
		}
	}
}

/** Relationship-based storage: a collection whose records live inside the folder of their parent. */
function placement(out, fail) {
	const claims = new Map();
	for (const [name, c] of out) {
		const under = c.storage.under;
		if (!under) continue;
		const where = `collection "${name}": storage.under`;
		const bad = subpathProblem(under.subfolder);
		if (bad) fail(`${where}.subfolder ${bad}`);
		if (c.storage.format === 'binary') fail(`${where}: this collection is format: binary — an opaque record is not placed under a parent; keep it in its own folder`);
		if (c.storage.shape === 'folder') fail(`${where}: this collection is shape: folder — a folder record is not placed under a parent; keep it in its own folder`);
		const f = c.resolved[under.parent];
		const targets = targetsOf(f);
		if (!targets || targets === '*' || targets.length !== 1 || f.many) fail(`${where}.parent "${under.parent}" must be a scalar reference to exactly one collection`);
		const parentName = targets[0];
		const p = out.get(parentName);
		if (!p) fail(`${where}: parent collection "${parentName}" is not installed — a record cannot live inside a folder nothing provides`);
		if (p.storage.under) fail(`${where}: "${parentName}" is itself stored under another collection — one level is supported`);
		if (p.storage.shape !== 'folder') fail(`${where}: "${parentName}" is not shape: folder — a record can only live INSIDE a parent that is a folder (storage: { shape: folder, entry: <file> } on ${parentName})`);
		if (p.storage.repo !== c.storage.repo) fail(`${where}: "${parentName}" lives in another git repo — a record and the folder it sits in must share one`);
		if (p.storage.entry && under.subfolder.split('/')[0] === p.storage.entry) fail(`${where}.subfolder "${under.subfolder}" collides with ${parentName}'s entry file "${p.storage.entry}" — pick a folder name`);
		const siblings = claims.get(parentName) ?? [];
		for (const s of siblings) {
			if (s.path === under.subfolder || s.path.startsWith(under.subfolder + '/') || under.subfolder.startsWith(s.path + '/')) {
				fail(`collections "${s.name}" and "${name}" both store records under ${parentName}/<id>/${s.path} — one would index the other's files; give each its own folder`);
			}
		}
		claims.set(parentName, [...siblings, { path: under.subfolder, name }]);
		// nested ids begin with the parent's id, so every id template must open with it
		if (under.id === 'nested') {
			const from = [c.doc.ids?.from ?? []].flat();
			const lead = new RegExp(`^\\{\\{\\s*${under.parent}\\s*\\|\\s*basename\\s*\\}\\}/`);
			if (!from.length || from.some((t) => !lead.test(String(t)))) fail(`${where}.id is nested, so every ids.from template must open with \`{{ ${under.parent} | basename }}/\` — the id begins with the parent's id`);
		}
		c.compiled.under_collection = parentName;
	}
}
