// The IMPLEMENTATION layer behind the verb-first CLI: `collectionCommand(ws, collection, verb, args)`
// is (collection, verb) shaped and stays that way — `cli.js` translates `dt <verb> <target>` onto it.
// So a spelling here (`collections add`, `<collection> add-field`, `commands for`, `repos ensure`) is
// an INTERNAL pair, not what the operator types; `dt schema add-collection` is what they type.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Store, bodyField, serialize, atomicWrite } from './store.js';
import { load, dump } from './yaml.js';
import { slug } from './template.js';
import {
	createCollection, removeCollection, renameCollection, addField, updateField, removeField, fieldDef, statedKeywords, relationFlagsStated, saveUiView, removeUiView,
	// was copy-pasted here, and the copy went stale the moment the source layout gained a second
	// spelling — one implementation, two callers
	workspaceSystemDir,
} from './schema-ops.js';
import { history, historyDiff } from './history.js';
import { commandsFor, recordResolver } from './record-commands.js';
import { distinctValues } from './field-values.js';
import { matchesFilter } from './filter.js';
import { baseNameOf, normalizeNamespaces } from './namespace.js';
import { sortRows } from './temporal.js';
import { keyBetween, placementKey } from './fractional-index.js';
import { ensureRepo, ensureAllRepos } from './init.js';
import { expectedMirrors } from './relations.js';
import { parseRecord } from './records.js';

/**
 * Emit MACHINE-READABLE output synchronously. Use this for every `--json` payload.
 *
 * `console.log` to a pipe is asynchronous, and every CLI path ends in `process.exit()`, which
 * discards whatever is still buffered. A shell pipeline hides the bug completely — the reader
 * drains concurrently, so `dreamteamer list contacts --json | wc -c` reports all 32381 bytes — but
 * the way a script or a coding agent actually calls this is execFileSync/spawnSync, and there the
 * child exits with the pipe still full. Measured before this fix: the same command captured with
 * execFileSync returned exactly **8190 bytes** (one pipe buffer) of that 32381-byte document, i.e.
 * silently invalid JSON, with a zero exit status.
 *
 * Found while writing a setup script for a second operator — the first consumer to read `--json`
 * from a real program rather than a terminal.
 *
 * ⚠ 2026-07-30: a SINGLE `fs.writeSync` was NOT enough, and the previous version of this comment
 * claimed it was. Writing to a pipe performs one `write(2)`, which returns a SHORT COUNT once the
 * 64KB pipe buffer is full — it does not throw, it reports fewer bytes written and the caller
 * ignores the number. So the same truncation reappeared at a larger size: measured at exactly
 * **65126 bytes** of a ~100KB payload, again invalid JSON with a zero exit status. `meetings list
 * --json` (141767 bytes) was affected. Found in a sibling script that reproduced it twice, once
 * per fix.
 *
 * So: write in a LOOP until every byte lands, and retry EAGAIN — stdout can be a non-blocking pipe.
 */
export const emit = (s) => {
  const buf = Buffer.from(s + '\n');
  let off = 0;
  while (off < buf.length) {
    try {
      off += fs.writeSync(1, buf, off, buf.length - off);
    } catch (e) {
      if (e.code === 'EAGAIN') continue;
      throw e;
    }
  }
};

/** `list` flags that are options, not `field=value` shorthand filters. */
const LIST_META_FLAGS = new Set(['json', 'filter', 'where', 'sort']);

export function collectionCommand(ws, collection, verb, args) {
	const store = new Store(ws);
	const { flags, pos } = parseArgs(args);

	// ---- meta verbs: schema operations write SOURCES, never the runtime ----------
	// These MUST come before the generic switch: their collections are system-stored, so the
	// ordinary record path refuses them ("… are system sources") and always would.
	if (collection === 'collections' && verb === 'add') return metaCollectionsAdd(ws, store, flags);
	if (collection === 'collections' && verb === 'rm') return metaCollectionsRm(ws, store, flags, pos);
	if (collection === 'collections' && verb === 'rename') return metaCollectionsRename(ws, store, flags, pos);
	if (collection === 'commands' && verb === 'for') return metaCommandsFor(ws, store, flags, pos);
	if (collection === 'ui-views' && ['add', 'set', 'rm'].includes(verb)) return metaUiView(ws, store, verb, flags, pos);
	if (collection === 'repos' && verb === 'ensure') return metaReposEnsure(ws, flags, pos);
	if (verb === 'add-field') return metaAddField(ws, store, collection, flags);
	if (verb === 'update-field') return metaUpdateField(ws, store, collection, flags);
	if (verb === 'remove-field') return metaRemoveField(ws, store, collection, flags);

	const d = store.descriptor(collection);

	switch (verb) {
		case 'list': {
			const filters = Object.entries(flags).filter(([k]) => !LIST_META_FLAGS.has(k));
			if (typeof flags.filter === 'string') {
				const eq = flags.filter.indexOf('=');
				filters.push([flags.filter.slice(0, eq), flags.filter.slice(eq + 1)]);
			}
			// `--where` is the SAME operator set the studio's filter panel emits and saved views
			// store — one `matchesFilter`, so `--where '{"starts":{"_gte":"2026-07-01"}}'` and the
			// panel that produced that JSON cannot disagree about which records match.
			const where = typeof flags.where === 'string' ? load(flags.where) : null;
			const resolve = where ? recordResolver(store) : null;
			const bf = bodyField(d);
			const rows = [];
			for (const { id, fields } of store.readAll(collection)) { // ONE walk, not one per record
				if (!filters.every(([k, v]) => String(fields[k] ?? '') === String(v))) continue;
				if (where && !matchesFilter({ ...fields, id }, where, resolve)) continue;
				if (bf) delete fields[bf]; // bodies don't belong in listings
				rows.push({ ...fields, id }); // record id WINS over any schema field named "id"
			}
			// sorting was studio-only until now: the browse table ordered records and no CLI
			// invocation could. Same `sortRows` the server and api.ts call, so `--sort -starts`
			// orders date-times by INSTANT across mixed offsets rather than by string.
			if (typeof flags.sort === 'string') sortRows(rows, flags.sort);
			if (flags.json) { emit(JSON.stringify(rows, null, 2)); return 0; }
			const cols = ['id', ...(d.list_fields ?? []).filter((c) => c !== 'id')];
			for (const r of rows) console.log(cols.map((c) => fmtCell(r[c])).join('  '));
			if (!rows.length) console.log(`(no ${collection}${filters.length || where ? ' matching' : ''})`);
			return 0;
		}
		case 'get': {
			const id = need(pos, 0, 'id');
			const { fields } = store.read(collection, id);
			flags.json ? emit(JSON.stringify({ ...fields, id }, null, 2)) : console.log(dump(fields).trimEnd());
			return 0;
		}
		case 'add': {
			// An opaque collection is written by IMPORTING a file: the id is positional (nothing can
			// generate it from fields that do not exist) and the bytes come from --from.
			if ((d.storage.codec ?? 'md') === 'file') {
				const id = need(pos, 0, 'id');
				if (!flags.from) throw new Error(`"${collection}" is a \`codec: file\` collection — pass --from <path> with the file to import`);
				const { id: written, file } = store.addFile(collection, id, flags.from, { force: !!flags.force });
				flags.json ? emit(JSON.stringify({ id: written, path: rel(ws.root, file) })) : console.log(`✔ ${rel(ws.root, file)}`);
				return 0;
			}
			if (flags.from) throw new Error(`--from imports a file as a record, and "${collection}" is not a \`codec: file\` collection`);
			const fields = coerceArrays(d, stripMeta(flags));
			const { id, file } = store.add(collection, fields, { id: flags.id });
			flags.json ? emit(JSON.stringify({ id, path: rel(ws.root, file) })) : console.log(`✔ ${rel(ws.root, file)}`);
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
			flags.json ? emit(JSON.stringify({ id })) : console.log('✔ updated');
			return 0;
		}
		// Manual ordering. ONE record is written per move — that is the entire feature; a dense
		// integer would renumber everything below the insertion point and bury the change. The field is
		// named by the descriptor (`sort_field`), never here, so a workspace may call it anything.
		case 'move': {
			const field = d.sort_field;
			if (!field) throw new Error(`collection "${collection}" declares no sort_field — add one to its descriptor before ordering it by hand.`);

			// Blanks sort FIRST (compareValues, via `?? ''`), so unplaced records surface at the top
			// rather than hiding at the bottom, and ties fall back to id order: `walk` reads name-sorted
			// and Array.sort is stable. That is the tiebreak two agents landing on the same key rely on.
			const rows = [];
			for (const { id: rid, fields } of store.readAll(collection)) rows.push({ id: rid, key: fields[field] ?? '' });
			sortRows(rows, 'key');

			if (flags.init) {
				// Idempotent: a record that already carries a key keeps it, so --init can be re-run after
				// adding records without disturbing an order the operator set by hand.
				let prev = rows.filter((r) => r.key).pop()?.key ?? null;
				let written = 0;
				for (const r of rows) {
					if (r.key) continue;
					prev = keyBetween(prev, null);
					store.set(collection, r.id, { [field]: prev });
					written++;
				}
				flags.json ? emit(JSON.stringify({ placed: written })) : console.log(written ? `✔ placed ${written} record(s) in ${field}` : '✔ nothing to place');
				return 0;
			}

			const id = need(pos, 0, 'id');
			store.set(collection, id, { [field]: placementKey(rows, id, flags, collection) });
			flags.json ? emit(JSON.stringify({ id })) : console.log('✔ moved');
			return 0;
		}
		case 'rm': {
			const id = need(pos, 0, 'id');
			const { inboundIgnored } = store.rm(collection, id, { force: !!flags.force });
			flags.json ? emit(JSON.stringify({ id, removed: true, inboundIgnored })) : console.log(`✔ removed${inboundIgnored ? ` (${inboundIgnored} inbound reference(s) left dangling — run \`dreamteamer check\`)` : ''}`);
			return 0;
		}
		case 'rename': {
			const out = store.rename(collection, need(pos, 0, 'old id'), need(pos, 1, 'new id'));
			if (flags.json) { emit(JSON.stringify(out)); return 0; }
			console.log(`✔ renamed ${collection}/${need(pos, 0, 'old id')} → ${collection}/${out.id}`);
			if (out.touched) console.log(`✔ rewrote ${out.rewrites} inbound reference(s) across ${out.touched} file(s)`);
			return 0;
		}
		// `dreamteamer values meetings status` — the vocabulary a field ACTUALLY uses, so a filter
		// or a command-binding validator can offer a dropdown for a plain `type: string` field that
		// no enum describes (operator: "still no dropdown for many things, visibility, status").
		case 'values': {
			const field = need(pos, 0, 'field');
			const out = distinctValues(store, collection, field, {
				limit: flags.limit === undefined ? undefined : Number(flags.limit),
			});
			if (flags.json) { emit(JSON.stringify(out, null, 2)); return 0; }
			if (out.skipped) { console.log(`(${collection}.${field} is a ${out.skipped} field — no value vocabulary)`); return 0; }
			if (!out.values.length) { console.log(`(no values set on ${collection}.${field})`); return 0; }
			for (const { value, count } of out.values) console.log(count == null ? String(value) : `${String(count).padStart(5)}  ${value}`);
			console.log(`— ${out.total} distinct${out.truncated ? ` (showing ${out.values.length})` : ''}, from ${out.source}`);
			return 0;
		}
		case 'history': {
			const id = need(pos, 0, 'id');
			const log = history(store, collection, id);
			if (flags.json) { emit(JSON.stringify(log, null, 2)); return 0; }
			if (!log.length) { console.log(`(no history for ${collection}/${id} — not committed yet)`); return 0; }
			for (const c of log) console.log(`${c.hash.slice(0, 7)}  ${c.date.slice(0, 10)}  ${c.author}  ${c.subject}`);
			return 0;
		}
		case 'diff': {
			const id = need(pos, 0, 'id');
			const out = historyDiff(store, collection, id, typeof flags.hash === 'string' ? flags.hash : 'HEAD');
			if (flags.json) { emit(JSON.stringify(out, null, 2)); return 0; }
			console.log(out.diff.trimEnd() || `(no change to ${out.path} in ${out.hash})`);
			return 0;
		}
		case 'revert': {
			const id = need(pos, 0, 'id');
			// the hash is REQUIRED and has no default: "revert" with an implied target is how you
			// destroy the wrong record. `<c> history <id>` is where you get one.
			const hash = typeof flags.hash === 'string' ? flags.hash : pos[1];
			if (!hash) throw new Error(`missing --hash <commit> — run \`dreamteamer history ${collection}/${id}\` to pick one`);
			const out = store.revert(collection, id, hash);
			flags.json ? emit(JSON.stringify(out)) : console.log(out.reverted ? `✔ reverted ${collection}/${id} to ${String(hash).slice(0, 7)}` : `= already identical to ${String(hash).slice(0, 7)} — nothing changed`);
			return 0;
		}
		default:
			throw new Error(`unknown verb "${verb}" — use list | get | add | set | rm | rename | values | history | diff | revert`);
	}
}



// Which bound commands apply, in which state (available / done / not-applicable). THE engine
// surface behind the studio's Commands tab (engine/UI parity: the verb lands first, the button
// second).
//
// ⚠ The COLLECTION arrives already resolved, and the ids only ever through `--ids`. This used to
// split its own target at the first slash — which cannot name a namespaced collection, so
// `commands finance/transactions` asked for a collection called "finance" and every namespaced
// target failed. `cli.js` owns reference resolution now (splitRef, longest declared prefix) and is
// the only caller, so a second, weaker splitter here could only ever disagree with it.
function metaCommandsFor(ws, store, flags, pos) {
	const collection = need(pos, 0, 'collection');
	const ids = typeof flags.ids === 'string' ? flags.ids.split(',').map((s) => s.trim()).filter(Boolean) : [];
	const out = commandsFor(store, collection, ids);
	if (flags.json) { emit(JSON.stringify(out, null, 2)); return 0; }
	if (!out.commands.length) { console.log(`(no commands bound to ${collection})`); return 0; }
	for (const c of out.commands) {
		if (c.target === 'collection') { console.log(`${c.name}  [collection]  ${c.invocation}`); continue; }
		const counts = ids.length ? `  ${c.eligible.length}/${ids.length} eligible${c.done.length ? `, ${c.done.length} done` : ''}` : '  (no ids given)';
		console.log(`${c.name}  [record]${counts}${c.invocation ? `\n  ${c.invocation}` : ''}`);
	}
	return 0;
}

/**
 * `repos ensure <id>` / `repos ensure --all` — materialize declared repos on demand.
 * Lazy by design: `install` deliberately does NOT do this, so a fresh workspace clone is
 * immediately workable without pulling every attached repo (and one unreachable remote can only
 * fail the action you asked for, not the whole install).
 */
function metaReposEnsure(ws, flags, pos) {
	const results = flags.all ? ensureAllRepos(ws) : [ensureRepo(ws, need(pos, 0, 'id'))];
	if (flags.json) { emit(JSON.stringify(results, null, 2)); return 0; }
	for (const r of results) console.log(r.cloned ? `✔ cloned ${r.path}` : `✔ ${r.path} (present)`);
	if (!results.length) console.log('(no repos declared)');
	return 0;
}

// `dreamteamer collections add --name research-docs --template docs`
function metaCollectionsAdd(ws, store, flags) {
	const { file } = createCollection(ws, store, { name: flags.name, template: flags.template, namespace: flags.namespace });
	console.log(`✔ ${rel(ws.root, file)}`);
	console.log('✔ compiled — the collection is live (schema ops prove sources with a real compile)');
	return 0;
}

// `dreamteamer collections rename doctors health/doctors`, or `… doctors --namespace health`.
// The whole point is that namespacing EXISTING data is one command instead of a six-step hand
// migration whose last step (rewriting references) dangles everything when forgotten.
function metaCollectionsRename(ws, store, flags, pos) {
	const [oldName, explicitNew] = pos;
	if (!oldName) throw new Error('usage: dreamteamer schema rename-collection <old> <new> | <old> --namespace <ns>');
	// `--namespace health` on its own moves the collection INTO that namespace keeping its bare name,
	// which is the common case and saves retyping it.
	const newName = explicitNew
		?? (flags.namespace ? `${String(flags.namespace).replace(/^\/+|\/+$/g, '')}/${baseNameOf(oldName, normalizeNamespaces(ws.pkg.dreamteamer?.namespaces))}` : null);
	if (!newName) throw new Error('missing new name — give it positionally or with --namespace <ns>');

	const out = renameCollection(ws, store, oldName, newName);
	if (flags.json) { emit(JSON.stringify(out)); return 0; }
	if (!out.renamed) { console.log(`✔ ${oldName} — already named that, nothing to do`); return 0; }
	console.log(`✔ ${oldName} → ${out.name}`);
	if (out.from !== out.to) console.log(`  records  ${out.from} → ${out.to} (${out.records})`);
	if (out.suffix) console.log(`  suffix   .${out.suffix.from}.md → .${out.suffix.to}.md`);
	if (out.pathKept) console.log(`  ⚠ storage.path kept as "${out.pathKept}" — it was authored, so the rename did not overrule it`);
	console.log(`  refs     ${out.rewrites} rewritten`);
	console.log('✔ compiled — the rename is live, in ONE commit');
	return 0;
}

// `dreamteamer collections rm widgets [--force]` — --force is required to drop a collection
// that still has records (removeCollection refuses otherwise, and says so).
function metaCollectionsRm(ws, store, flags, pos) {
	const name = need(pos, 0, 'collection name');
	const out = removeCollection(ws, store, name, { force: !!flags.force });
	flags.json ? emit(JSON.stringify(out)) : console.log(`✔ removed collection ${out.removed}`);
	console.log('✔ compiled — the collection is gone');
	return 0;
}

// `dreamteamer tasks add-field --name urgent --type boolean --default-value false`
function metaAddField(ws, store, collection, flags) {
	const prop = fieldDef(store, flags, collection);
	// fieldDef DEFERS every relation flag it has no reference to attach to, because on update-field
	// the target is carried in afterwards. add-field has nothing to carry, so a relation flag that
	// landed nowhere is a mistake — refused here rather than written as a dead keyword.
	const stray = (prop.items ?? prop)['x-reference'] === undefined && relationFlagsStated(flags);
	if (stray) throw new Error(`--${stray} needs a --type <collection> reference.`);
	const out = addField(ws, store, collection, { name: flags.name, prop, required: flags.required === 'true' });
	if (out.unchanged) return alreadyThat(collection, flags.name);
	console.log(`✔ ${rel(ws.root, out.file)}${out.extends ? ` (extends ${out.extends})` : ''}`);
	console.log('✔ compiled — the field is live');
	reportMirror(store, collection, flags.name, out.prop);
	return 0;
}

/** The idempotent answer, in `rename-collection`'s words — a command that asks for what is already
 *  there succeeded, and the operator needs to know which field it was talking about. */
function alreadyThat(collection, field) {
	console.log(`✔ ${collection}.${field} — already exactly that, nothing to do`);
	return 0;
}

/** A relation writes a field onto ANOTHER collection — the one consequence of add-field/update-field
 *  that the written path above does not show. And the mirror is only correct for records written
 *  AFTER it existed, so records already carrying a value are counted here, with the repair: this is
 *  the migration path (a plain FK gains its mirror) and check flags every one of them the moment
 *  the field lands. */
function reportMirror(store, collection, fieldName, prop) {
	const holder = prop.items ?? prop;
	if (!holder['x-inverse']) return;
	const target = holder['x-reference'];
	console.log(`  mirror: ${target}.${holder['x-inverse']}${holder['x-unique'] === true ? '' : '[]'}  (generated, read-only)`);
	const n = [...store.readAll(collection)].filter((r) => r.fields[fieldName] != null).length;
	if (n) console.log(`  ${n} ${collection} ${n === 1 ? 'record carries' : 'records carry'} values — run: dreamteamer relations rebuild ${target}`);
}

// `dreamteamer tasks update-field --name urgent --type enum --options a,b --required false`
// Same flag vocabulary as add-field (one `fieldDef`), so the two read as one operation with two
// preconditions rather than two dialects.
function metaUpdateField(ws, store, collection, flags) {
	if (!flags.name) throw new Error('missing --name <field>');
	const prop = fieldDef(store, flags, collection);
	// tri-state: omitting --required leaves requiredness ALONE, rather than silently clearing it
	const required = flags.required === undefined ? undefined : flags.required === 'true' || flags.required === true;
	// `flags` for the VALUES and `stated` for what the caller meant to restate: updateField carries
	// every unstated relation keyword forward from the previous prop.
	const out = updateField(ws, store, collection, flags.name, { prop, required, flags, stated: statedKeywords(flags) });
	if (out.unchanged) return alreadyThat(collection, flags.name);
	console.log(`✔ ${rel(ws.root, out.file)}${out.extends ? ` (extends ${out.extends})` : ''}`);
	console.log('✔ compiled — the field is updated');
	// off `out.prop`, never the one passed in: updateField reassigns it when it rebuilds a carried
	// reference as an array, and reporting off the stale object printed nothing on exactly the
	// migration path where check fails on the very next command.
	reportMirror(store, collection, flags.name, out.prop);
	return 0;
}

// `dreamteamer tasks remove-field --name urgent`
function metaRemoveField(ws, store, collection, flags) {
	const name = flags.name ?? flags.field;
	if (!name) throw new Error('missing --name <field>');
	const out = removeField(ws, store, collection, name);
	flags.json ? emit(JSON.stringify(out)) : console.log(`✔ removed field ${collection}.${out.removed}`);
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

/**
 * Assign `a.b.c` into a nested object, creating plain objects on the way down.
 *
 * An empty or null value REMOVES the key rather than writing `''` — the same convention
 * `store.set` has always used for top-level fields (`if (v === null || v === '') delete next[k]`),
 * extended to the nested paths the meta verbs address. Without it there was no way to take a key
 * back out of a `ui-view`'s `options`, so a superseded option lingered as `provider: ''` and the
 * only cure was `rm` + `add`.
 *
 * Intermediate objects are not created on the way to a delete: unsetting `a.b` on a record with no
 * `a` should leave the record alone, not grow an empty `a: {}`.
 */
function assignPath(target, dotted, value) {
	const keys = dotted.split('.');
	const leaf = keys[keys.length - 1];
	const unset = value === null || value === '';
	let node = target;
	for (const k of keys.slice(0, -1)) {
		if (node[k] == null || typeof node[k] !== 'object' || Array.isArray(node[k])) {
			if (unset) return;
			node[k] = {};
		}
		node = node[k];
	}
	if (unset) delete node[leaf];
	else node[leaf] = value;
}

const VIEW_META_FLAGS = new Set(['id', 'json', 'force']);

function metaUiView(ws, store, verb, flags, pos) {
	if (verb === 'rm') {
		const out = removeUiView(ws, store, need(pos, 0, 'ui-view id'));
		flags.json ? emit(JSON.stringify(out)) : console.log(`✔ removed ui-view ${out.removed}`);
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
	flags.json ? emit(JSON.stringify(out)) : console.log(`✔ ${rel(ws.root, out.file)}`);
	console.log(`✔ compiled — ${view.path} is live`);
	return 0;
}

/**
 * `dt relations [<collection>] [--json]` — every two-way pair the compiled runtime declares — and
 * `dt relations rebuild <collection> [--drop <field>]`.
 *
 * Rebuild is not a convenience verb: `check` prints "<mirror>: stale — run: dreamteamer relations
 * rebuild <target>", so this IS the other half of that sentence and has to repair exactly the state
 * check flags. That is why the staleness comparison below is character-for-character the one in
 * check.js — two spellings of "stale" would send the operator round a loop that never converges.
 */
export function relationsCommand(ws, args) {
	const store = new Store(ws);
	const { flags, pos } = parseArgs(args);
	if (pos[0] === 'rebuild') return relationsRebuild(store, flags, pos);

	// `store.relations()` is `relationsOf(this.descriptors)` memoized per Store — going through it
	// rather than calling relationsOf here keeps one decoder for the whole process.
	const rows = store.relations().filter((r) => !pos[0] || r.owner === pos[0] || r.target === pos[0]);
	if (flags.json) { emit(JSON.stringify(rows, null, 2)); return 0; }
	if (!rows.length) {
		console.log(pos[0] ? `no two-way relations touch ${pos[0]}` : 'no two-way relations declared');
		return 0;
	}
	// `[]` on the mirror is cardinality, not decoration: it is the difference between a field the
	// operator can read as one reference and one they have to iterate.
	const cells = rows.map((r) => [`${r.owner}.${r.field}`, `${r.target}.${r.mirror}${r.unique ? '' : '[]'}`, r.kind, r.onDelete]);
	const width = (i) => Math.max(...cells.map((c) => c[i].length));
	const [w0, w1, w2] = [width(0), width(1), width(2)];
	for (const c of cells) console.log(`${c[0].padEnd(w0)}  →  ${c[1].padEnd(w1)}  ${c[2].padEnd(w2)}  ${c[3]}`);
	return 0;
}

function relationsRebuild(store, flags, pos) {
	const collection = pos[1];
	if (!collection) throw new Error('usage: dreamteamer relations rebuild <collection> [--drop <field>]');
	const d = store.descriptor(collection);
	// The two shapes compile refuses to stamp a mirror onto, refused again here — because --drop
	// writes even when NO relation targets this collection, and `serialize` has no branch for
	// `codec: file`: it would replace the record's own bytes (an SVG, a PDF) with frontmatter.
	if (!store.canRewrite(collection)) {
		const why = d.storage.base === 'runtime' ? 'a compiled source' : 'stored as `codec: file`';
		throw new Error(`"${collection}" is ${why} — it carries no generated mirrors and this verb will not rewrite it.`);
	}
	// `--drop` LAST on the line parses as the boolean `true`. Quietly treating that as "no --drop"
	// printed a green "rebuilt 0 records", which the operator reads as "the residue key is gone" —
	// the one sentence that must never be said falsely by a repair verb.
	if ('drop' in flags && (typeof flags.drop !== 'string' || !flags.drop.trim())) {
		throw new Error('--drop needs a field name: dreamteamer relations rebuild <collection> --drop <field>');
	}
	const drop = typeof flags.drop === 'string' ? flags.drop : null;
	if (drop && d.schema?.properties?.[drop]) throw new Error(`"${drop}" is a live field of ${collection} — --drop only removes keys the schema no longer declares.`);

	// Expectations computed ONCE per relation, over a single pass of each owning collection. The
	// store's own `applyMirrorEdits` re-walks the owners per write, which is right for one edit and
	// quadratic for a whole collection — so rebuild does not build on it.
	const unreadableOwners = [];
	const expected = store.relations()
		.filter((r) => r.target === collection)
		.map((r) => ({ r, exp: expectedMirrors(r, parseEach(store, r.owner, (f) => unreadableOwners.push(rel(store.root, f)))) }));
	// An owner that will not parse takes its edges with it — and rebuild would then DELETE the mirror
	// values those edges justify. Refuse while nothing has been written yet; a skip here is data loss,
	// unlike a skip on the target side below, which only leaves a record unrepaired.
	if (unreadableOwners.length) {
		throw new Error(`cannot rebuild ${collection}: ${unreadableOwners.join(', ')} will not parse — fix the owning record first (\`dreamteamer check\` names the syntax error).`);
	}

	let rebuilt = 0;
	// The write lock, like every other write verb: several agents work in one tree, and a concurrent
	// `dt set` landing mid-sweep would be clobbered back to the pre-set mirror value.
	store.withWriteLock(() => {
		for (const { id, file, fields } of parseEach(store, collection, (f) => console.warn(`⚠ ${rel(store.root, f)}: parse error, skipped — \`dreamteamer check\` reports it`))) {
			let changed = false;
			for (const { r, exp } of expected) {
				const want = exp.get(id);
				const have = fields[r.mirror];
				// ⚠ COERCE THE WAY AJV DOES. `check` validates with `coerceTypes: 'array'`, which mutates
				// the record in place BEFORE its relation pass — so it compares a coerced value while this
				// reads the raw parse. Unmatched, the two disagree in both directions: `recordings: 5`
				// crashed the spread here ("(have ?? []) is not iterable") on the very record check had
				// just named, mid-loop and after earlier writes; and `recordings: recordings/cap` read as
				// stale here while check called it fine.
				const list = Array.isArray(have) ? have : have == null ? [] : [have];
				// the comparison check.js makes: a unique relation mirrors to a scalar, everything else
				// to a sorted array, and absent reads the same as empty
				const same = r.unique
					? (have ?? null) === (want ?? null)
					: JSON.stringify([...list].sort()) === JSON.stringify(want ?? []);
				if (same) continue;
				if (want == null) delete fields[r.mirror];
				else fields[r.mirror] = want;
				changed = true;
			}
			if (drop && drop in fields) { delete fields[drop]; changed = true; }
			// each record is written AT MOST ONCE, whatever number of relations point at it
			if (changed && atomicWrite(file, serialize(d, fields))) rebuilt++;
		}
	});
	if (flags.json) { emit(JSON.stringify({ collection, rebuilt })); return 0; }
	// auto-commit is off by default, so these writes are sitting dirty — but only say so when
	// something actually landed; a commit hint after "rebuilt 0" is an instruction to do nothing.
	const hint = rebuilt ? ` — run: dreamteamer commit ${collection}` : '';
	console.log(`✔ rebuilt ${rebuilt} record${rebuilt === 1 ? '' : 's'}${hint}`);
	return 0;
}

/** `store.readAll` for a reader that must SURVIVE a bad record. It is a generator, so a parse error
 *  mid-walk cannot be resumed past — and rebuild is the one reader that has already written by the
 *  time a later record blows up, so an abort leaves a partial sweep behind an error naming no file
 *  at all. Here the bad record is handed to `onError` and skipped, and the walk finishes. */
function* parseEach(store, collection, onError) {
	const d = store.descriptor(collection);
	const bf = bodyField(d);
	for (const [id, file] of store.ids(collection)) {
		let fields;
		try {
			fields = parseRecord(file, d, bf);
		} catch (e) {
			onError(file, e);
			continue;
		}
		yield { id, file, fields };
	}
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
