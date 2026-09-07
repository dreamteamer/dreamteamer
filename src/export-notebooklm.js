// `dt export notebooklm` — the workspace rendered for a consumer that is not a coding agent.
//
// compile writes the runtime for five harnesses that read FILES. NotebookLM reads none: it holds a
// bounded number of SOURCES per notebook (Google's plan table), takes its standing instructions as a
// 10,000-character PERSONA, and answers only from what it was given. So this adapter renders three
// things — the schema as one hierarchical source (workspace → module → collection → field), the
// records as sharded sources inside the plan's budget, and the persona from a Markdown template —
// and, given a notebook id, makes the notebook match (add · replace · remove, by title).
//
// Two rules hold the privacy line, and both are SCHEMA rather than flags or a side file:
//   `sensitive: true` on a descriptor  → the whole collection is omitted and NAMED as omitted
//   `x-sensitive: true` on a field     → the field is projected out of every record
// Nothing is inferred from a field's name. `email` is exported unless somebody marked it, and the
// report prints every field that WAS exported per collection, so the review is one read.
//
// The vendor CLI (`notebooklm`, notebooklm-py ≥ 0.7.3) is reached through ONE function, `nlm`, and
// only when `--notebook` or `--create` is passed. Without either, export is a pure render and the
// suite can pin every decision on the bytes it writes.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Store, bodyField } from './store.js';
import { engineVersion } from './compile.js';
import { satisfies } from './semver.js';

/** Sources per notebook, per plan — Google's published table (support.google.com/notebooklm/answer/16213268,
 *  read 2026-09). A bare number is accepted too, for a Workspace or Enterprise tier the table does not name. */
export const PLANS = { standard: 50, plus: 100, pro: 300, ultra: 600 };
/** The persona cap `notebooklm configure --persona` states. */
export const PERSONA_MAX = 10000;
/** Google documents 500,000 words per source; the default leaves room for the shard header and for
 *  citations to land on a record rather than on a wall of them. */
export const DEFAULT_MAX_WORDS = 200000;
/** Every source this adapter owns carries this prefix — it is how a sync tells its own stale sources
 *  from a paper the operator added by hand, which it never touches. */
export const OWNED_PREFIX = 'dt · ';
export const SCHEMA_TITLE = `${OWNED_PREFIX}schema`;
export const DEFAULT_OUT = path.join('.cache', 'dreamteamer', 'notebooklm');
export const EXPORT_FLAGS = ['out', 'plan', 'max-words', 'collections', 'instructions', 'notebook', 'create', 'response-length', 'mode', 'wait', 'json'];
export const TARGETS = ['notebooklm'];

export const words = (text) => { const t = String(text ?? '').trim(); return t ? t.split(/\s+/).length : 0; };
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// ---- projection -----------------------------------------------------------------------------------

export function omittedFields(d) {
	return Object.entries(d.schema?.properties ?? {}).filter(([, p]) => p?.['x-sensitive'] === true).map(([k]) => k).sort();
}

/** Why a collection is not exported as records, or null when it is. */
export function exportability(d) {
	if (d.storage?.base === 'runtime') return 'system';
	if (d.storage?.codec === 'file') return 'file';
	if (d.sensitive === true) return 'sensitive';
	return null;
}

export function projectRecord(d, fields) {
	const drop = new Set(omittedFields(d));
	const kept = {};
	const dropped = [];
	for (const [k, v] of Object.entries(fields)) (drop.has(k) ? dropped : null)?.push(k) ?? (kept[k] = v);
	return { kept, dropped };
}

// ---- rendering ------------------------------------------------------------------------------------

function fieldLine(name, p, required) {
	const bits = [];
	const ref = p['x-reference'] ?? p.items?.['x-reference']; // a many-reference carries the target on `items`
	if (ref) bits.push(`reference → ${ref}${p.type === 'array' ? ', many' : ''}`);
	else if (p.enum) bits.push(`enum: ${p.enum.join(' | ')}`);
	else if (p.type === 'array') bits.push(`list of ${p.items?.type ?? 'string'}`);
	else bits.push(p.format && p.format !== 'markdown' ? `${p.type}, ${p.format}` : p.type ?? 'string');
	if (required) bits.push('required');
	if (p.default !== undefined) bits.push(`default ${JSON.stringify(p.default).replace(/^"|"$/g, '')}`);
	if (p['x-body']) bits.push('body');
	let line = `- ${name} (${bits.join(', ')})`;
	if (p['x-sensitive'] === true) return `${line} — sensitive, not exported`;
	if (p.description) line += `: ${flat(p.description)}`;
	return line;
}

/** The module records compile projected, each with the skills and commands found under its path.
 *  Read from disk rather than the manifest because the manifest names roots and not what is in them. */
function modulesIndex(store, root) {
	const out = [];
	if (!store.descriptors.has('modules')) return out;
	for (const { id, fields: m } of store.readAll('modules')) {
		const modRoot = m.path && m.path !== '.' ? path.join(root, m.path) : root;
		const skills = safeList(path.join(modRoot, 'skills'), (e) => e.isDirectory() && fs.existsSync(path.join(modRoot, 'skills', e.name, 'SKILL.md')));
		const commands = safeList(path.join(modRoot, 'commands'), (e) => e.name.endsWith('.command.md')).map((c) => c.replace(/\.command\.md$/, ''));
		out.push({ id, title: m.title ?? id, description: flat(m.description), namespaces: m.namespaces ?? [], collections: (m.collections ?? []).map((r) => String(r).replace(/^collections\//, '')), skills, commands });
	}
	return out.sort((a, b) => a.title.localeCompare(b.title));
}
const safeList = (dir, keep) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter(keep).map((e) => e.name).sort(); } catch { return []; } };

/** The schema source: workspace → module → collection → field, one heading level per step. */
export function renderSchema({ workspace, version, exportedAt, modules, descriptors, omitted, selected }) {
	const data = [...descriptors.values()].filter((d) => d.storage?.base !== 'runtime').sort((a, b) => a.name.localeCompare(b.name));
	const system = [...descriptors.values()].filter((d) => d.storage?.base === 'runtime').map((d) => d.name).sort();
	const lines = [
		`# ${workspace} — schema`,
		'',
		`This is a dreamteamer workspace: typed records in collections, grouped by module. Every record is cited as \`<collection>/<id>\`, and the other sources in this notebook hold the records themselves, one source (or shard) per collection. This source is the map.`,
		'',
		`engine dreamteamer ${version} · ${modules.length} modules · ${data.length} collections (${data.length - omitted.collections.length} exported, ${omitted.collections.length} omitted as sensitive)`,
	];
	const placed = new Set();
	const groups = modules.filter((m) => m.collections.some((c) => descriptors.get(c) && descriptors.get(c).storage?.base !== 'runtime'));
	const renderCollection = (d) => {
		placed.add(d.name);
		const why = exportability(d);
		lines.push('', `### collection: ${d.name}`);
		if (d.description) lines.push(flat(d.description));
		// ⚠ A WITHHELD COLLECTION IS NAMED AND THEN THE ENTRY STOPS. Naming it is deliberate — the reader
		// has to know the gap exists — but its SCHEMA is not neutral: a field description carries authored
		// examples (a real vat-period id, a real trip name) and an enum publishes the value set itself
		// (`relation: parent-partner …` describes a household). Measured on a real vault: 5 of 23 canary
		// hits came from this block alone, from collections whose records were correctly withheld.
		if (why === 'sensitive') {
			lines.push('⚠ sensitive — not exported: no record, field or value of this collection is in this notebook.');
			return;
		}
		if (d.use_when) lines.push(`use when: ${flat(d.use_when)}`);
		const idShape = [d.id?.generate ? `generated as ${d.id.generate}` : null, d.id?.pattern ? `pattern ${d.id.pattern}` : null].filter(Boolean).join(', ');
		lines.push(`id: ${idShape || 'free'} · storage: ${d.storage?.path ?? '?'} (${d.storage?.codec ?? 'md'})`);
		if (why === 'file') lines.push('binary records — not exported.');
		else if (selected && !selected.has(d.name)) lines.push('not included in this export (--collections).');
		const required = new Set(d.schema?.required ?? []);
		for (const [name, p] of Object.entries(d.schema?.properties ?? {})) lines.push(fieldLine(name, p ?? {}, required.has(name)));
	};
	for (const m of groups) {
		lines.push('', `## module: ${m.title} (\`${m.id}\`)`);
		if (m.description) lines.push(m.description);
		const ships = [
			...(m.namespaces.length ? [`namespaces: ${m.namespaces.join(', ')}`] : []),
			...(m.skills.length ? [`skills: ${m.skills.join(', ')}`] : []),
			...(m.commands.length ? [`commands: ${m.commands.map((c) => `/${c}`).join(', ')}`] : []),
		];
		if (ships.length) lines.push(ships.join(' · '));
		for (const name of m.collections.sort()) { const d = descriptors.get(name); if (d && d.storage?.base !== 'runtime') renderCollection(d); }
	}
	const orphans = data.filter((d) => !placed.has(d.name));
	if (orphans.length) { lines.push('', '## module: (workspace root)'); for (const d of orphans) renderCollection(d); }
	if (system.length) lines.push('', `system collections (not exported as records): ${system.join(', ')} — these are the workspace's own definitions; this document is their rendering.`);
	return lines.join('\n') + '\n';
}

/** module → its collections, one line each: what the persona can afford of the schema. */
export function schemaBrief(modules, descriptors, omitted) {
	const skip = new Set(omitted.collections);
	const lines = [];
	for (const m of modules) {
		const own = m.collections.filter((c) => descriptors.get(c) && descriptors.get(c).storage?.base !== 'runtime');
		if (!own.length) continue;
		lines.push(`- ${m.title}: ${own.map((c) => skip.has(c) ? `${c} (sensitive, absent)` : c).join(', ')}`);
	}
	return lines.join('\n');
}

const demote = (md) => String(md).replace(/^(#{1,4})(\s)/gm, (_, h, s) => `${h}##${s}`);

/** ⚠ A REFERENCE INTO A WITHHELD COLLECTION IS ITSELF A DISCLOSURE, and the sharper half is that an
 *  id is not an opaque handle here — ids are authored, so they carry account numbers, people's names
 *  and trip destinations. Withholding `finance/accounts` while an exported task still reads
 *  `finance/accounts/<bank>-<account number>` withholds nothing. Measured on a real vault: 11 of 23
 *  canary hits were exactly this, in field values AND in body prose (`[[…]]` links and bare refs).
 *
 *  So every rendered text — record sections, the schema source, the persona — goes through this. The
 *  collection NAME survives, because "there is a finance account behind this and you were not given
 *  it" is a true and useful sentence; the id does not. Longest name first, so `finance/accounts`
 *  cannot claim a reference belonging to `finance/account-source-artifacts`. */
export function redactWithheld(text, withheld) {
	let out = String(text);
	for (const name of [...withheld].sort((a, b) => b.length - a.length)) {
		out = out.replace(new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[A-Za-z0-9._~:@+/-]+`, 'g'), `${name}/… (withheld)`);
	}
	return out;
}

function value(v, labels) {
	if (Array.isArray(v)) return v.map((x) => value(x, labels)).join(', ');
	if (v && typeof v === 'object') return JSON.stringify(v);
	const s = String(v);
	const label = labels.get(s);
	return label ? `${s} (${label})` : s;
}

/** One record as a `## <collection>/<id>` section: kept fields as a list, the body after a blank line. */
export function renderRecord(d, id, fields, labels) {
	const bf = bodyField(d);
	const { kept } = projectRecord(d, fields);
	const lines = [`## ${d.name}/${id}`];
	for (const [k, v] of Object.entries(kept)) {
		if (k === bf || v === undefined || v === null || v === '') continue;
		lines.push(`- ${k}: ${value(v, labels)}`);
	}
	if (bf && kept[bf]) lines.push('', demote(kept[bf]).trim());
	return lines.join('\n') + '\n';
}

/** ⚠ NO TIMESTAMP AND NO ENGINE VERSION IN A SHARD. The sync decides "unchanged" by hashing the
 *  bytes, so anything volatile here re-uploads every source on every run — the first live sync
 *  replaced four untouched collections because this line carried the export minute. Dates live in
 *  the manifest and the persona, which are rewritten anyway. */
function shardHeader(d, exported, n, m, count, meta) {
	const lines = [`# ${d.name}${d.description ? ` — ${flat(d.description)}` : ''}`];
	if (d.use_when) lines.push(`use when: ${flat(d.use_when)}`);
	lines.push(`fields exported: ${exported.join(', ')}`);
	lines.push(`records: ${count}${m > 1 ? ` · shard ${n}/${m}` : ''} · workspace ${meta.workspace}`, '');
	return lines.join('\n') + '\n';
}

/** Greedy, in id order: a shard closes when the next section would push it over `maxWords`. */
export function shardSections(sections, maxWords) {
	const shards = [[]];
	let used = 0;
	for (const s of sections) {
		const w = words(s.text);
		if (w > maxWords) throw new Error(`record ${s.id} alone is ${w} words, over the per-source cap ${maxWords} — raise --max-words or mark the field it lives in`);
		if (used + w > maxWords && shards.at(-1).length) { shards.push([]); used = 0; }
		shards.at(-1).push(s);
		used += w;
	}
	return shards;
}

export const sourceTitle = (collection, n, m) => `${OWNED_PREFIX}${collection}${m > 1 ? ` [${n}/${m}]` : ''}`;
export const sourceFile = (collection, n, m) => `${collection.replace(/\//g, '--')}${m > 1 ? `--${String(n).padStart(2, '0')}` : ''}.md`;

export function sourceLimit(plan) {
	if (/^\d+$/.test(String(plan))) return Number(plan);
	if (plan in PLANS) return PLANS[plan];
	throw new Error(`unknown plan "${plan}" — one of ${Object.keys(PLANS).join(', ')}, or a bare number of sources`);
}

// ---- the persona -----------------------------------------------------------------------------------

export const DEFAULT_TEMPLATE = `You are the reference desk for the workspace "{{workspace}}", a dreamteamer workspace exported on {{exported_at}} (engine {{engine_version}}).

The sources are the workspace itself: "{{schema_title}}" is the map — every module, collection and field — and each other source holds the records of one collection, one "## <collection>/<id>" section per record. Answer ONLY from the sources, cite the record ids you used, and when the sources do not hold the answer say so plainly rather than inferring.

What this workspace keeps, by module:
{{schema_brief}}

Not in this notebook, deliberately: {{omitted}}. If asked about them, say they were withheld from the export rather than guessing.

When a question names a person, an organisation or a thing, find its record first and answer from the fields on it; when it asks what recurs, read across the collection. Give record ids in the form <collection>/<id> so the reader can open them.`;

export function renderInstructions(template, vars) {
	const out = String(template).replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, key) => {
		if (!(key in vars)) throw new Error(`unknown placeholder "${key}" in the instructions template — known: ${Object.keys(vars).join(', ')}`);
		return String(vars[key]);
	});
	if (out.length > PERSONA_MAX) throw new Error(`the rendered instructions are ${out.length} characters and NotebookLM's persona takes at most ${PERSONA_MAX} — shorten the template, or drop {{sources}}/{{schema_brief}}`);
	return out;
}

// ---- the bundle -----------------------------------------------------------------------------------

export function buildBundle(ws, flags = {}) {
	const store = new Store(ws);
	const version = engineVersion();
	const exportedAt = new Date().toISOString().slice(0, 16).replace('T', ' ') + 'Z';
	const workspace = ws.pkg?.name ?? path.basename(ws.root);
	const maxWords = flags['max-words'] !== undefined ? Number(flags['max-words']) : DEFAULT_MAX_WORDS;
	if (!Number.isFinite(maxWords) || maxWords < 1) throw new Error(`--max-words takes a positive number — got "${flags['max-words']}"`);
	const wanted = flags.collections !== undefined ? [].concat(flags.collections).flatMap((s) => String(s).split(',')).map((s) => s.trim()).filter(Boolean) : null;
	for (const c of wanted ?? []) if (!store.descriptors.has(c)) throw new Error(`unknown collection "${c}" in --collections`);
	const selected = wanted ? new Set(wanted) : null;
	const descriptors = store.descriptors;
	const modules = modulesIndex(store, ws.root);

	const omitted = { collections: [], fields: {} };
	const exportable = [];
	for (const d of [...descriptors.values()].sort((a, b) => a.name.localeCompare(b.name))) {
		const why = exportability(d);
		if (why === 'sensitive') omitted.collections.push(d.name);
		if (why) continue;
		if (selected && !selected.has(d.name)) continue;
		const of = omittedFields(d);
		if (of.length) omitted.fields[d.name] = of;
		exportable.push(d);
	}

	// labels first, so a reference renders as `companies/acme (Acme Ltd)` whichever shard it lands in
	const labels = new Map();
	const rows = new Map();
	for (const d of exportable) {
		const list = [...store.readAll(d.name)].sort((a, b) => a.id.localeCompare(b.id));
		rows.set(d.name, list);
		const drop = new Set(omittedFields(d));
		for (const r of list) {
			const label = ['name', 'title'].map((k) => (drop.has(k) ? undefined : r.fields[k])).find((v) => typeof v === 'string' && v.trim());
			if (label) labels.set(`${d.name}/${r.id}`, flat(label));
		}
	}

	const meta = { workspace, version, exportedAt };
	const withheld = new Set(omitted.collections);
	const sources = [];
	const schemaText = redactWithheld(renderSchema({ workspace, version, exportedAt, modules, descriptors, omitted, selected }), withheld);
	sources.push({ title: SCHEMA_TITLE, file: '00-schema.md', text: schemaText, words: words(schemaText), records: [], collection: null, shard: [1, 1] });
	for (const d of exportable) {
		const list = rows.get(d.name);
		if (!list.length) continue;
		const exportedFields = Object.keys(d.schema?.properties ?? {}).filter((k) => !omittedFields(d).includes(k));
		const header = shardHeader(d, exportedFields, 1, 1, list.length, meta);
		const budget = maxWords - words(header) - 4; // the header's own words come off the cap
		if (budget < 1) throw new Error(`--max-words ${maxWords} is smaller than the shard header of ${d.name} (${words(header)} words)`);
		const sections = list.map((r) => ({ id: r.id, text: redactWithheld(renderRecord(d, r.id, r.fields, labels), withheld) }));
		const shards = shardSections(sections, budget);
		shards.forEach((secs, i) => {
			const text = shardHeader(d, exportedFields, i + 1, shards.length, secs.length, meta) + secs.map((s) => s.text).join('\n');
			sources.push({ title: sourceTitle(d.name, i + 1, shards.length), file: sourceFile(d.name, i + 1, shards.length), text, words: words(text), records: secs.map((s) => s.id), collection: d.name, shard: [i + 1, shards.length] });
		});
	}

	const plan = flags.plan !== undefined ? String(flags.plan) : 'standard';
	const limit = sourceLimit(plan);
	if (sources.length > limit) {
		throw new Error(`${sources.length} sources (schema + ${sources.length - 1} shards), and plan ${plan} allows ${limit} per notebook.\n  narrow with --collections <a,b,…>, raise the shard size with --max-words, or name the account's plan with --plan ${Object.keys(PLANS).join('|')}|<n>`);
	}

	const omittedText = [
		...omitted.collections.map((c) => `the whole collection ${c}`),
		...Object.entries(omitted.fields).map(([c, fs_]) => `${c}.${fs_.join(`, ${c}.`)}`),
	].join('; ') || 'nothing';
	const template = flags.instructions !== undefined ? fs.readFileSync(path.resolve(ws.root, String(flags.instructions)), 'utf8') : DEFAULT_TEMPLATE;
	const instructions = redactWithheld(renderInstructions(template, {
		workspace, engine_version: version, exported_at: exportedAt, schema_title: SCHEMA_TITLE,
		schema_brief: schemaBrief(modules, descriptors, omitted) || '- (no collections)',
		sources: sources.map((s) => s.title).join(', '),
		omitted: omittedText,
		collections: exportable.length,
	}), withheld);

	return { workspace, version, exportedAt, plan, limit, sources, omitted, instructions, exportedFields: Object.fromEntries(exportable.map((d) => [d.name, Object.keys(d.schema?.properties ?? {}).filter((k) => !omittedFields(d).includes(k))])) };
}

/** Write the bundle, pruning shards a previous export left. `notebook.json` (sync state) is kept. */
export function writeBundle(outDir, bundle) {
	fs.mkdirSync(outDir, { recursive: true });
	const keep = new Set([...bundle.sources.map((s) => s.file), 'instructions.md', 'manifest.json', 'notebook.json']);
	for (const f of fs.readdirSync(outDir)) if (!keep.has(f) && (f.endsWith('.md') || f === 'manifest.json')) fs.rmSync(path.join(outDir, f));
	for (const s of bundle.sources) fs.writeFileSync(path.join(outDir, s.file), s.text);
	fs.writeFileSync(path.join(outDir, 'instructions.md'), bundle.instructions);
	const manifest = {
		workspace: bundle.workspace, engine: bundle.version, exported_at: bundle.exportedAt,
		budget: { plan: bundle.plan, limit: bundle.limit, used: bundle.sources.length },
		sources: bundle.sources.map((s) => ({ title: s.title, file: s.file, sha256: sha256(s.text), words: s.words, records: s.records, collection: s.collection, shard: s.shard })),
		omitted: bundle.omitted,
		exported_fields: bundle.exportedFields,
	};
	fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
	return manifest;
}

// ---- sync ------------------------------------------------------------------------------------------

/** What a sync will do, decided from four inputs and no network: the sources wanted (title + sha),
 *  the sources the notebook has (id + title), the last sync's state (title → source_id + sha), and
 *  the bundle's file names.
 *
 *  ⚠ KEYED ON SOURCE IDS, NOT TITLES. `notebooklm source add --title` on a file upload keeps the
 *  title on some uploads and the FILE NAME on others (measured 2 of 5, then 0 of 4, on 0.7.3), so a
 *  title-keyed plan re-added every source it could not find and left the previous copy behind. The
 *  state file remembers which id each title landed on; a title is only what the reader sees, and the
 *  sync renames a source whose title came back wrong. Ownership — what may be REMOVED — is: an id the
 *  state tracks, a title carrying OWNED_PREFIX, or a title equal to one of the bundle's file names
 *  (the exact shape the dropped-title bug leaves behind). Anything else is the operator's. */
export function planSync(wanted, existing, state = {}, ownedFiles = new Set()) {
	const plan = { add: [], replace: [], skip: [], remove: [] };
	const byId = new Map(existing.map((e) => [e.id, e]));
	const tracked = new Set(Object.values(state).map((s) => s.source_id));
	const accounted = new Set();
	for (const w of wanted) {
		const prev = state[w.title];
		const live = prev ? byId.get(prev.source_id) : undefined;
		if (live && prev.sha256 === w.sha256) { plan.skip.push({ ...w, sourceId: live.id, renameFrom: live.title !== w.title ? live.title : null }); accounted.add(live.id); }
		else if (live) { plan.replace.push({ ...w, oldId: live.id }); accounted.add(live.id); }
		else plan.add.push(w);
	}
	for (const e of existing) {
		if (accounted.has(e.id)) continue;
		if (tracked.has(e.id) || String(e.title).startsWith(OWNED_PREFIX) || ownedFiles.has(e.title)) plan.remove.push({ title: e.title, id: e.id });
	}
	return plan;
}

/** THE one seam to the vendor CLI. Every call names the notebook explicitly; `notebooklm use` is never
 *  run, because that writes a single shared context file that concurrent sessions would overwrite. */
function nlm(args, { json = true, timeoutMs = 600000 } = {}) {
	const res = spawnSync('notebooklm', ['--quiet', ...args, ...(json ? ['--json'] : [])], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
	if (res.error?.code === 'ENOENT') throw new Error('the `notebooklm` CLI is not on PATH — `pip install -U notebooklm-py`, then `notebooklm login`');
	if (res.status !== 0) throw new Error(`notebooklm ${args.slice(0, 2).join(' ')} failed (exit ${res.status}): ${(res.stderr || res.stdout || '').trim().split('\n').slice(-3).join(' | ')}`);
	if (!json) return res.stdout;
	const text = res.stdout.trim();
	const start = text.search(/[[{]/);
	try { return JSON.parse(start > 0 ? text.slice(start) : text); } catch { throw new Error(`notebooklm ${args.slice(0, 2).join(' ')} printed no JSON: ${text.slice(0, 200)}`); }
}

function preflight() {
	const v = spawnSync('notebooklm', ['--version'], { encoding: 'utf8' });
	if (v.error?.code === 'ENOENT') throw new Error('the `notebooklm` CLI is not on PATH — `pip install -U notebooklm-py`, then `notebooklm login`');
	const ver = /(\d+\.\d+\.\d+)/.exec(v.stdout ?? '')?.[1];
	if (!ver || satisfies(ver, '>=0.7.3') === false) throw new Error(`notebooklm ${ver ?? '?'} is too old — this adapter needs >= 0.7.3 (pip install -U notebooklm-py)`);
	// `auth check` without --test only inspects cookie SHAPE and says "valid" against an expired
	// session; --test fetches a token. One network call up front beats a half-synced notebook.
	const a = spawnSync('notebooklm', ['--quiet', 'auth', 'check', '--test'], { encoding: 'utf8', timeout: 60000 });
	if (a.status !== 0) throw new Error(`notebooklm auth check --test failed — run \`notebooklm login\` (a browser opens; an agent cannot do this for you)\n  ${(a.stderr || a.stdout || '').trim().split('\n').at(-1) ?? ''}`);
	return ver;
}

export function syncNotebook(outDir, manifest, flags, log = console.log) {
	preflight();
	let notebookId = flags.notebook !== undefined ? String(flags.notebook) : undefined;
	const stateFile = path.join(outDir, 'notebook.json');
	let state = {};
	try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* first sync */ }
	if (!notebookId && flags.create !== undefined) {
		const created = nlm(['create', String(flags.create)]);
		notebookId = created?.notebook?.id ?? created?.id;
		if (!notebookId) throw new Error(`notebooklm create returned no id: ${JSON.stringify(created).slice(0, 200)}`);
		log(`✔ created notebook ${notebookId} — "${flags.create}"`);
	}
	if (!notebookId) notebookId = state.notebook_id;
	if (!notebookId) throw new Error('no notebook to sync — pass --notebook <id>, or --create "<title>" once (the id is then kept in notebook.json)');
	if (state.notebook_id && state.notebook_id !== notebookId) state = {}; // a different notebook: no prior source ids apply

	const listed = nlm(['source', 'list', '-n', notebookId]);
	const existing = (Array.isArray(listed) ? listed : listed?.sources ?? []).map((s) => ({ id: s.id, title: s.title ?? '' }));
	const plan = planSync(manifest.sources, existing, state.sources ?? {}, new Set(manifest.sources.map((s) => s.file)));
	const next = { notebook_id: notebookId, synced_at: new Date().toISOString(), sources: {} };
	for (const s of plan.skip) {
		next.sources[s.title] = { source_id: s.sourceId, sha256: s.sha256 };
		if (s.renameFrom) { nlm(['source', 'rename', s.sourceId, s.title, '-n', notebookId]); log(`  ~ renamed  "${s.renameFrom}" → ${s.title}`); }
	}
	for (const r of plan.remove) { nlm(['source', 'delete', r.id, '-n', notebookId, '-y']); log(`  - removed  ${r.title}`); }
	const added = [];
	for (const r of plan.replace) { nlm(['source', 'delete', r.oldId, '-n', notebookId, '-y']); }
	for (const s of [...plan.replace, ...plan.add]) {
		const res = nlm(['source', 'add', path.join(outDir, s.file), '--type', 'file', '--title', s.title, '-n', notebookId, '--request-timeout', '180']);
		const id = res?.source?.id ?? res?.id;
		if (!id) throw new Error(`notebooklm source add returned no id for ${s.title}: ${JSON.stringify(res).slice(0, 200)}`);
		// ⚠ ALWAYS, not "when the title came back wrong": the title `add` reports is not the one the
		// notebook keeps (see planSync). One extra call per new source buys a readable source list.
		nlm(['source', 'rename', id, s.title, '-n', notebookId]);
		next.sources[s.title] = { source_id: id, sha256: s.sha256 };
		added.push({ id, title: s.title });
		log(`  ${plan.replace.includes(s) ? '~ replaced' : '+ added   '} ${s.title} (${s.words} words)`);
	}
	fs.writeFileSync(stateFile, JSON.stringify(next, null, 2) + '\n'); // state lands before configure, so a failure there loses nothing
	const persona = fs.readFileSync(path.join(outDir, 'instructions.md'), 'utf8');
	const cfg = ['configure', '-n', notebookId, '--persona', persona];
	if (flags['response-length'] !== undefined) cfg.push('--response-length', String(flags['response-length']));
	if (flags.mode !== undefined) cfg.push('--mode', String(flags.mode));
	nlm(cfg);
	log(`✔ persona set (${persona.length} chars${flags['response-length'] ? `, response length ${flags['response-length']}` : ''}${flags.mode ? `, mode ${flags.mode}` : ''})`);
	const waited = [];
	if (flags.wait && added.length) {
		for (const a of added) {
			if (!a.id) continue;
			const r = spawnSync('notebooklm', ['--quiet', 'source', 'wait', a.id, '-n', notebookId, '--timeout', '600', '--interval', '5'], { encoding: 'utf8', timeout: 660000 });
			waited.push({ title: a.title, ready: r.status === 0 });
			log(`  ${r.status === 0 ? '✔ ready   ' : '✖ not ready'} ${a.title}`);
		}
	}
	return { notebook_id: notebookId, added: plan.add.length, replaced: plan.replace.length, unchanged: plan.skip.length, removed: plan.remove.length, waited };
}

// ---- the verb --------------------------------------------------------------------------------------

export function exportCommand(ws, target, flags) {
	if (!target || target.startsWith('--')) throw new Error(`dt export needs a target: dreamteamer export ${TARGETS.join('|')} [--out <dir>] …`);
	if (!TARGETS.includes(target)) throw new Error(`unknown export target "${target}" — known: ${TARGETS.join(', ')}`);
	const bundle = buildBundle(ws, flags);
	const outDir = path.resolve(ws.root, flags.out !== undefined ? String(flags.out) : DEFAULT_OUT);
	const manifest = writeBundle(outDir, bundle);
	const rel = path.relative(ws.root, outDir) || '.';
	const wantsSync = flags.notebook !== undefined || flags.create !== undefined;
	let sync = null;
	const quiet = !!flags.json;
	const log = quiet ? () => {} : console.log;
	if (!quiet) {
		log(`✔ ${rel}/ — ${manifest.sources.length} sources (${manifest.budget.used}/${manifest.budget.limit} on plan ${manifest.budget.plan}), persona ${bundle.instructions.length}/${PERSONA_MAX} chars`);
		for (const s of manifest.sources) log(`    ${s.title.padEnd(36)} ${String(s.words).padStart(7)} words${s.records.length ? `  ${s.records.length} records` : ''}`);
		if (manifest.omitted.collections.length) log(`  omitted collections (sensitive): ${manifest.omitted.collections.join(', ')}`);
		for (const [c, f] of Object.entries(manifest.omitted.fields)) log(`  omitted fields: ${c}.${f.join(`, ${c}.`)}`);
	}
	if (wantsSync) {
		sync = syncNotebook(outDir, manifest, flags, log);
		log(`✔ notebook ${sync.notebook_id}: +${sync.added} added · ~${sync.replaced} replaced · =${sync.unchanged} unchanged · -${sync.removed} removed`);
	}
	if (quiet) console.log(JSON.stringify({ ...manifest, out: rel, sync }, null, 2));
	return 0;
}
