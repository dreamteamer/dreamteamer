// noun-verb collection commands: dreamteamer <collection> list|get|add|set|rm|rename
// + meta verbs: `collections add --name --template` and `<collection> add-field`
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Store, bodyField } from './store.js';
import { load, dump } from './yaml.js';
import { slug } from './template.js';
import { createCollection, addField, fieldDef } from './schema-ops.js';
import { createRun } from './runs.js';

export function collectionCommand(ws, collection, verb, args) {
	const store = new Store(ws);
	const { flags, pos } = parseArgs(args);

	// ---- meta verbs: schema operations write SOURCES, never the runtime ----------
	if (collection === 'collections' && verb === 'add') return metaCollectionsAdd(ws, store, flags);
	if (collection === 'workflows' && verb === 'run') return metaWorkflowsRun(ws, store, flags, pos);
	if (verb === 'add-field') return metaAddField(ws, store, collection, flags);

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
		default:
			throw new Error(`unknown verb "${verb}" — use list | get | add | set | rm | rename`);
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

// `dreamteamer collections add --name research-docs --template docs`
function metaCollectionsAdd(ws, store, flags) {
	const { file } = createCollection(ws, store, { name: flags.name, template: flags.template });
	console.log(`✔ ${rel(ws.root, file)}`);
	console.log('✔ compiled — the collection is live (schema ops prove sources with a real compile)');
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
