// noun-verb collection commands: dreamteamer <collection> list|get|add|set|rm|rename|history|diff|revert
// + meta verbs: `collections add|rm`, `<collection> add-field|update-field|remove-field`,
//   `ui-views add|set|rm`, `workflows run`
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Store, bodyField } from './store.js';
import { load, dump } from './yaml.js';
import { slug } from './template.js';
import {
	createCollection, removeCollection, addField, updateField, removeField, fieldDef, saveUiView, removeUiView,
} from './schema-ops.js';
import { history, historyDiff } from './history.js';
import { createRun } from './runs.js';
import { commandsFor } from './record-commands.js';

export function collectionCommand(ws, collection, verb, args) {
	const store = new Store(ws);
	const { flags, pos } = parseArgs(args);

	// ---- meta verbs: schema operations write SOURCES, never the runtime ----------
	// These MUST come before the generic switch: their collections are system-stored, so the
	// ordinary record path refuses them ("… are system sources") and always would.
	if (collection === 'collections' && verb === 'add') return metaCollectionsAdd(ws, store, flags);
	if (collection === 'collections' && verb === 'rm') return metaCollectionsRm(ws, store, flags, pos);
	if (collection === 'workflows' && verb === 'run') return metaWorkflowsRun(ws, store, flags, pos);
	if (collection === 'commands' && verb === 'for') return metaCommandsFor(ws, store, flags, pos);
	if (collection === 'ui-views' && ['add', 'set', 'rm'].includes(verb)) return metaUiView(ws, store, verb, flags, pos);
	if (verb === 'add-field') return metaAddField(ws, store, collection, flags);
	if (verb === 'update-field') return metaUpdateField(ws, store, collection, flags);
	if (verb === 'remove-field') return metaRemoveField(ws, store, collection, flags);

	const d = store.descriptor(collection);

	switch (verb) {
		case 'list': {
			const filters = Object.entries(flags).filter(([k]) => !['json', 'filter'].includes(k));
			if (typeof flags.filter === 'string') {
				const eq = flags.filter.indexOf('=');
				filters.push([flags.filter.slice(0, eq), flags.filter.slice(eq + 1)]);
			}
			const bf = bodyField(d);
			const rows = [];
			for (const { id, fields } of store.readAll(collection)) { // ONE walk, not one per record
				if (!filters.every(([k, v]) => String(fields[k] ?? '') === String(v))) continue;
				if (bf) delete fields[bf]; // bodies don't belong in listings
				rows.push({ ...fields, id }); // record id WINS over any schema field named "id"
			}
			if (flags.json) { console.log(JSON.stringify(rows, null, 2)); return 0; }
			const cols = ['id', ...(d.list_fields ?? []).filter((c) => c !== 'id')];
			for (const r of rows) console.log(cols.map((c) => fmtCell(r[c])).join('  '));
			if (!rows.length) console.log(`(no ${collection}${filters.length ? ' matching' : ''})`);
			return 0;
		}
		case 'get': {
			const id = need(pos, 0, 'id');
			const { fields } = store.read(collection, id);
			console.log(flags.json ? JSON.stringify({ ...fields, id }, null, 2) : dump(fields).trimEnd());
			return 0;
		}
		case 'add': {
			const fields = coerceArrays(d, stripMeta(flags));
			const { id, file } = store.add(collection, fields, { id: flags.id });
			console.log(flags.json ? JSON.stringify({ id, path: rel(ws.root, file) }) : `✔ ${rel(ws.root, file)}`);
			return 0;
		}
		case 'set': {
			const id = need(pos, 0, 'id');
			const changes = coerceArrays(d, Object.fromEntries(
				pos.slice(1).filter((p) => p.includes('=')).map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)])
			));
			Object.assign(changes, coerceArrays(d, stripMeta(flags)));
			if (!Object.keys(changes).length) throw new Error('nothing to set — pass key=value pairs or --key value flags');
			store.set(collection, id, changes);
			console.log(flags.json ? JSON.stringify({ id }) : '✔ updated');
			return 0;
		}
		case 'rm': {
			const id = need(pos, 0, 'id');
			const { inboundIgnored } = store.rm(collection, id, { force: !!flags.force });
			console.log(flags.json ? JSON.stringify({ id, removed: true, inboundIgnored }) : `✔ removed${inboundIgnored ? ` (${inboundIgnored} inbound reference(s) left dangling — run \`dreamteamer check\`)` : ''}`);
			return 0;
		}
		case 'rename': {
			const out = store.rename(collection, need(pos, 0, 'old id'), need(pos, 1, 'new id'));
			if (flags.json) { console.log(JSON.stringify(out)); return 0; }
			console.log(`✔ renamed ${collection}/${need(pos, 0, 'old id')} → ${collection}/${out.id}`);
			if (out.touched) console.log(`✔ rewrote ${out.rewrites} inbound reference(s) across ${out.touched} file(s)`);
			return 0;
		}
		case 'history': {
			const id = need(pos, 0, 'id');
			const log = history(store, collection, id);
			if (flags.json) { console.log(JSON.stringify(log, null, 2)); return 0; }
			if (!log.length) { console.log(`(no history for ${collection}/${id} — not committed yet)`); return 0; }
			for (const c of log) console.log(`${c.hash.slice(0, 7)}  ${c.date.slice(0, 10)}  ${c.author}  ${c.subject}`);
			return 0;
		}
		case 'diff': {
			const id = need(pos, 0, 'id');
			const out = historyDiff(store, collection, id, typeof flags.hash === 'string' ? flags.hash : 'HEAD');
			if (flags.json) { console.log(JSON.stringify(out, null, 2)); return 0; }
			console.log(out.diff.trimEnd() || `(no change to ${out.path} in ${out.hash})`);
			return 0;
		}
		case 'revert': {
			const id = need(pos, 0, 'id');
			// the hash is REQUIRED and has no default: "revert" with an implied target is how you
			// destroy the wrong record. `<c> history <id>` is where you get one.
			const hash = typeof flags.hash === 'string' ? flags.hash : pos[1];
			if (!hash) throw new Error(`missing --hash <commit> — run \`dreamteamer ${collection} history ${id}\` to pick one`);
			const out = store.revert(collection, id, hash);
			console.log(flags.json ? JSON.stringify(out) : out.reverted ? `✔ reverted ${collection}/${id} to ${String(hash).slice(0, 7)}` : `= already identical to ${String(hash).slice(0, 7)} — nothing changed`);
			return 0;
		}
		default:
			throw new Error(`unknown verb "${verb}" — use list | get | add | set | rm | rename | history | diff | revert`);
	}
}

// workspace-owned system sources live in the workspace module when configured
// (package.json dreamteamer.workspace-module), else in the root system/
function workspaceSystemDir(ws, kind) {
	const wm = ws.pkg.dreamteamer?.['workspace-module'];
	return wm ? path.join(ws.root, 'modules', wm, 'system', kind) : path.join(ws.root, 'system', kind);
}

// `dreamteamer workflows run <id> --items <ref>[,<ref>…]` — create a VALIDATED run
// record per the run-state contract; execution stays with the attended executor.
function metaWorkflowsRun(ws, store, flags, pos) {
	const wfId = pos[0];
	if (!wfId) throw new Error('usage: dreamteamer workflows run <workflow-id> --items <collection>/<id>[,…]');
	const items = typeof flags.items === 'string' ? flags.items.split(',').map((s) => s.trim()).filter(Boolean) : [];
	const { id } = createRun(store, wfId, items);
	console.log(flags.json ? JSON.stringify({ id: `workflow-runs/${id}` }) : `✔ run created: workflow-runs/${id}`);
	console.log('… execution is attended: follow the `executing-workflows` skill to advance it');
	return 0;
}

// `dreamteamer commands for <collection>[/<id>] [--ids <id>[,…]] [--json]` — which bound
// commands apply, in which state (available / done / not-applicable). THE engine surface
// behind the studio's Commands tab (engine/UI parity: the verb lands first, the button second).
function metaCommandsFor(ws, store, flags, pos) {
	const target = need(pos, 0, 'collection[/id]');
	const slash = target.indexOf('/');
	const collection = slash > 0 ? target.slice(0, slash) : target;
	const ids = slash > 0
		? [target.slice(slash + 1)]
		: typeof flags.ids === 'string' ? flags.ids.split(',').map((s) => s.trim()).filter(Boolean) : [];
	const out = commandsFor(store, collection, ids);
	if (flags.json) { console.log(JSON.stringify(out, null, 2)); return 0; }
	if (!out.commands.length) { console.log(`(no commands bound to ${collection})`); return 0; }
	for (const c of out.commands) {
		if (c.target === 'collection') { console.log(`${c.name}  [collection]  ${c.invocation}`); continue; }
		const counts = ids.length ? `  ${c.eligible.length}/${ids.length} eligible${c.done.length ? `, ${c.done.length} done` : ''}` : '  (no ids given)';
		console.log(`${c.name}  [record]${counts}${c.invocation ? `\n  ${c.invocation}` : ''}`);
	}
	return 0;
}

// `dreamteamer collections add --name research-docs --template docs`
function metaCollectionsAdd(ws, store, flags) {
	const { file } = createCollection(ws, store, { name: flags.name, template: flags.template });
	console.log(`✔ ${rel(ws.root, file)}`);
	console.log('✔ compiled — the collection is live (schema ops prove sources with a real compile)');
	return 0;
}

// `dreamteamer collections rm widgets [--force]` — --force is required to drop a collection
// that still has records (removeCollection refuses otherwise, and says so).
function metaCollectionsRm(ws, store, flags, pos) {
	const name = need(pos, 0, 'collection name');
	const out = removeCollection(ws, store, name, { force: !!flags.force });
	console.log(flags.json ? JSON.stringify(out) : `✔ removed collection ${out.removed}`);
	console.log('✔ compiled — the collection is gone');
	return 0;
}

// `dreamteamer tasks add-field --name urgent --type boolean --default-value false`
function metaAddField(ws, store, collection, flags) {
	const prop = fieldDef(store, flags);
	const out = addField(ws, store, collection, { name: flags.name, prop, required: flags.required === 'true' });
	console.log(`✔ ${rel(ws.root, out.file)}${out.extends ? ` (extends ${out.extends})` : ''}`);
	console.log('✔ compiled — the field is live');
	return 0;
}

// `dreamteamer tasks update-field --name urgent --type enum --options a,b --required false`
// Same flag vocabulary as add-field (one `fieldDef`), so the two read as one operation with two
// preconditions rather than two dialects.
function metaUpdateField(ws, store, collection, flags) {
	if (!flags.name) throw new Error('missing --name <field>');
	const prop = fieldDef(store, flags);
	// tri-state: omitting --required leaves requiredness ALONE, rather than silently clearing it
	const required = flags.required === undefined ? undefined : flags.required === 'true' || flags.required === true;
	const out = updateField(ws, store, collection, flags.name, { prop, required });
	console.log(`✔ ${rel(ws.root, out.file)}${out.extends ? ` (extends ${out.extends})` : ''}`);
	console.log('✔ compiled — the field is updated');
	return 0;
}

// `dreamteamer tasks remove-field --name urgent`
function metaRemoveField(ws, store, collection, flags) {
	const name = flags.name ?? flags.field;
	if (!name) throw new Error('missing --name <field>');
	const out = removeField(ws, store, collection, name);
	console.log(flags.json ? JSON.stringify(out) : `✔ removed field ${collection}.${out.removed}`);
	console.log('✔ compiled — the field is gone');
	return 0;
}

// ---- ui-views ---------------------------------------------------------------------------------
// A view is an ordinary record conceptually (decision 49) but a SYSTEM-stored one, so it goes
// through saveUiView's compile gate rather than the record store. Without these verbs everything
// the Layout options panel does — columns, order, sort, layout, filter, nav — was click-only.

/** `--options '{"sort":"-date"}'` style flags, plus dotted `options.sort=-date` positionals. */
function parseViewValue(raw) {
	if (typeof raw !== 'string') return raw;
	const t = raw.trim();
	if (t === 'true') return true;
	if (t === 'false') return false;
	if (t !== '' && !Number.isNaN(Number(t))) return Number(t);
	if (t.startsWith('{') || t.startsWith('[')) {
		try { return JSON.parse(t); } catch { throw new Error(`not valid JSON: ${t}`); }
	}
	return raw;
}

/** Assign `a.b.c` into a nested object, creating plain objects on the way down. */
function assignPath(target, dotted, value) {
	const keys = dotted.split('.');
	let node = target;
	for (const k of keys.slice(0, -1)) {
		if (node[k] == null || typeof node[k] !== 'object' || Array.isArray(node[k])) node[k] = {};
		node = node[k];
	}
	node[keys[keys.length - 1]] = value;
}

const VIEW_META_FLAGS = new Set(['id', 'json', 'force']);

function metaUiView(ws, store, verb, flags, pos) {
	if (verb === 'rm') {
		const out = removeUiView(ws, store, need(pos, 0, 'ui-view id'));
		console.log(flags.json ? JSON.stringify(out) : `✔ removed ui-view ${out.removed}`);
		console.log('✔ compiled — the route is gone');
		return 0;
	}

	// `set` edits what the record already says; `add` starts from nothing. Reading through the
	// store means `set` works on a MODULE-shipped view too — the edit lands as a workspace source
	// that shadows it, which is the same thing saving one in the UI does.
	let view = {};
	let id = typeof flags.id === 'string' ? flags.id : undefined;
	if (verb === 'set') {
		id ??= need(pos, 0, 'ui-view id');
		const { fields } = store.read('ui-views', id);
		view = JSON.parse(JSON.stringify(fields));
		delete view.id; // the id is the filename, never a body key
	}

	for (const p of pos.slice(verb === 'set' ? 1 : 0)) {
		if (!p.includes('=')) continue;
		assignPath(view, p.slice(0, p.indexOf('=')), parseViewValue(p.slice(p.indexOf('=') + 1)));
	}
	for (const [k, v] of Object.entries(flags)) {
		if (VIEW_META_FLAGS.has(k)) continue;
		assignPath(view, k, parseViewValue(v));
	}

	if (!view.path) throw new Error('missing --path </route> — a view is addressed by its route');
	// same id rule the descriptor declares (`{{ path | slug }}`) and the UI derives, so a view
	// saved from the CLI and one saved from the panel land on the SAME record.
	id ??= slug(view.path);

	const out = saveUiView(ws, store, { id, view });
	console.log(flags.json ? JSON.stringify(out) : `✔ ${rel(ws.root, out.file)}`);
	console.log(`✔ compiled — ${view.path} is live`);
	return 0;
}

function parseArgs(args) {
	const flags = {};
	const pos = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a.startsWith('--')) {
			const eq = a.indexOf('=');
			if (eq > -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
			else if (i + 1 < args.length && !args[i + 1].startsWith('--')) flags[a.slice(2)] = args[++i];
			else flags[a.slice(2)] = true;
		} else pos.push(a);
	}
	return { flags, pos };
}

const META_FLAGS = new Set(['id', 'json', 'force', 'filter']);
const stripMeta = (flags) => Object.fromEntries(Object.entries(flags).filter(([k]) => !META_FLAGS.has(k)));

// CLI values are strings; split comma-lists for array-typed fields (ajv coerces the rest)
function coerceArrays(d, fields) {
	const out = {};
	for (const [k, v] of Object.entries(fields)) {
		out[k] = d.schema.properties?.[k]?.type === 'array' && typeof v === 'string'
			? v.split(',').map((s) => s.trim()).filter(Boolean)
			: v;
	}
	return out;
}

function need(pos, i, what) {
	if (pos[i] === undefined) throw new Error(`missing <${what}>`);
	return pos[i];
}

const fmtCell = (v) => (v === undefined ? '-' : Array.isArray(v) ? v.join(',') : String(v));

function rel(root, p) {
	return p.startsWith(root) ? p.slice(root.length + 1) : p;
}
