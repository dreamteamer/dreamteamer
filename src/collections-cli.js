// The IMPLEMENTATION layer behind the verb-first CLI: `collectionCommand(ws, collection, verb, args)`
// is (collection, verb) shaped and stays that way — `cli.js` translates `dt <verb> <target>` onto it.
// So a spelling here (`collections add`, `<collection> add-field`, `commands for`, `repos ensure`) is
// an INTERNAL pair, not what the operator types; `dt add collections` is what they type.
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
	createModule, removeModule, renameModule, setModule, moveCollection, setCollectionScalars, collectionSourceFileFor, removeFieldPlan, renameField, renameFieldPlan,
	createSkill, refuseHandAuthored, removeEntity, renameEntity, setEntityFrontmatter,
} from './schema-ops.js';
import { KINDS } from './compile.js';
import { history, historyDiff } from './history.js';
import { commandsFor, recordResolver } from './record-commands.js';
import { distinctValues } from './field-values.js';
import { matchesFilter } from './filter.js';
import { baseNameOf, defaultStoragePath } from './namespace.js';
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

	// ---- system verbs: source writes, never the runtime ----------
	// These MUST come before the generic switch: their collections are system-stored, so the
	// ordinary record path refuses them ("… are system sources") and always would.
	if (collection === 'collections' && verb === 'add') return metaCollectionsAdd(ws, store, flags);
	if (collection === 'collections' && verb === 'rm') return metaCollectionsRm(ws, store, flags, pos);
	if (collection === 'collections' && verb === 'rename') return metaCollectionsRename(ws, store, flags, pos);
	if (collection === 'collections' && verb === 'set') return metaCollectionsSet(ws, store, flags, pos);
	if (collection === 'collections' && verb === 'get' && flags.module !== undefined) return metaCollectionsGet(ws, store, flags, pos);
	if (collection === 'commands' && verb === 'for') return metaCommandsFor(ws, store, flags, pos);
	if (collection === 'ui-views' && ['add', 'set', 'rm'].includes(verb)) return metaUiView(ws, store, verb, flags, pos);
	if (collection === 'modules' && verb === 'add') return metaModulesAdd(ws, store, flags);
	if (collection === 'modules' && verb === 'rm') return metaModulesRm(ws, store, flags, pos);
	if (collection === 'modules' && verb === 'rename') return metaModulesRename(ws, store, flags, pos);
	if (collection === 'modules' && verb === 'set') return metaModulesSet(ws, store, flags, pos);
	if (collection === 'repos' && verb === 'ensure') return metaReposEnsure(ws, flags, pos);
	if (verb === 'add-field') return metaAddField(ws, store, collection, flags);
	if (verb === 'update-field') return metaUpdateField(ws, store, collection, flags);
	if (verb === 'remove-field') return metaRemoveField(ws, store, collection, flags);
	if (verb === 'rename-field') return metaRenameField(ws, store, collection, flags);

	// ---- the identity entities. §3.1's last row: `add` scaffolds a skill and is refused WITH THE
	// PATH for the four hand-authored kinds; `set` edits frontmatter; `rm` and `rename` work on all
	// five. Keyed on the collection NAME rather than on `storage.base` because these five are the
	// ones with a source-file shape — `modules` is projected and `collections` has its own verbs.
	if (ENTITY_KINDS.has(collection) && ['add', 'set', 'rm', 'rename'].includes(verb)) {
		return metaEntityVerb(ws, store, collection, verb, flags, pos);
	}
	// `revert` on ANY system entity: its history is git's, and `store.revert` writes a RECORD.
	if (verb === 'revert' && store.descriptors.get(collection)?.storage?.base === 'runtime') {
		const src = sourceHintFor(store, collection);
		throw new Error(`${collection}/${pos[0] ?? '<id>'} is a compiled source, so there is no record to revert — its source is in git.\n  git log -- ${src}\n  git checkout <sha> -- ${src}\n  dreamteamer compile`);
	}

	const d = store.descriptor(collection);

	switch (verb) {
		case 'list': {
			// EVERY condition, ANDed — a repeated flag composes rather than replacing. `--filter a=1
			// --filter b=2` used to keep only `b=2` and return rows the caller had excluded, which is
			// the one failure a narrowing verb must not have: a listing that answers a question nobody
			// asked, at exit 0. Bare-field flags (`--status todo`) already composed this way; the
			// meta flag now reads the same, and `[].concat` treats one and many alike.
			const filters = Object.entries(flags)
				.filter(([k]) => !LIST_META_FLAGS.has(k))
				.flatMap(([k, v]) => [].concat(v).map((one) => [k, one]));
			for (const cond of [].concat(flags.filter ?? [])) {
				const eq = String(cond).indexOf('=');
				// `--filter status` is not a condition. It used to slice into `statu = status`, which
				// matches nothing and reads as a fact about the collection.
				if (eq < 1) throw new Error(`--filter takes <field>=<value> — got "${cond}"`);
				filters.push([String(cond).slice(0, eq), String(cond).slice(eq + 1)]);
			}
			// `--where` is the SAME operator set the studio's filter panel emits and saved views
			// store — one `matchesFilter`, so `--where '{"starts":{"_gte":"2026-07-01"}}'` and the
			// panel that produced that JSON cannot disagree about which records match.
			const whereJson = oneValue(flags, 'where');
			const where = whereJson ? load(whereJson) : null;
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
			const sort = oneValue(flags, 'sort');
			if (sort) sortRows(rows, sort);
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
			const changes = coerceArrays(d, pairs(pos.slice(1)));
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
			const out = historyDiff(store, collection, id, oneValue(flags, 'hash') ?? 'HEAD');
			if (flags.json) { emit(JSON.stringify(out, null, 2)); return 0; }
			console.log(out.diff.trimEnd() || `(no change to ${out.path} in ${out.hash})`);
			return 0;
		}
		case 'revert': {
			const id = need(pos, 0, 'id');
			// the hash is REQUIRED and has no default: "revert" with an implied target is how you
			// destroy the wrong record. `<c> history <id>` is where you get one.
			const hash = oneValue(flags, 'hash') ?? pos[1];
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
	const ids = (oneValue(flags, 'ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
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

// ---- modules ----------------------------------------------------------------------------------
// A module is the one system entity that had no verbs at all, which is what left system-entity CRUD
// incomplete: there was no `add-module`, no `rm-module`, no `rename-field`, and no way to NAME a
// target module. §6.2.

// `dreamteamer add modules --name core [--description "…"]`
function metaModulesAdd(ws, store, flags) {
	refuseRepeats(flags);
	const out = createModule(ws, store, { name: oneValue(flags, 'name'), description: oneValue(flags, 'description') });
	if (flags.json) { emit(JSON.stringify(out)); return 0; }
	console.log(`✔ ${out.root}/ — package.json + ${KIND_COUNT} kind folder(s)`);
	console.log('✔ compiled — the module is live (add a collection with `dreamteamer add collections --name <c> --module ' + out.id + '`)');
	reportCommits(out.commits);
	return 0;
}

// `dreamteamer rm modules/core [--force] [--dry-run]`
function metaModulesRm(ws, store, flags, pos) {
	refuseRepeats(flags);
	const id = need(pos, 0, 'module id');
	const out = removeModule(ws, store, id, { force: !!flags.force, dryRun: !!flags['dry-run'] });
	if (flags.json) { emit(JSON.stringify(out)); return 0; }
	if (out.dryRun) {
		console.log(`dry run — dreamteamer rm modules/${id} --force would:`);
		console.log(planLine(out));
		if (out.collections.length) console.log(`  sources removed for: ${out.collections.join(', ')}`);
		if (out.withRecords.length) console.log(`  records left in place and UNINDEXED: ${out.withRecords.join(', ')}`);
		if (out.dependents.length) console.log(`  dependencies entry dropped from: ${out.dependents.join(', ')}`);
		return 0;
	}
	console.log(`✔ removed module ${out.removed}`);
	if (out.withRecords.length) console.log(`  ⚠ records remain and are now unindexed: ${out.withRecords.join(', ')}`);
	if (out.dependents.length) console.log(`  dropped it from ${out.dependents.join(', ')}'s dependencies`);
	console.log('✔ compiled — the module is gone');
	reportCommits(out.commits);
	return 0;
}

// `dreamteamer rename modules/core shared`
function metaModulesRename(ws, store, flags, pos) {
	refuseRepeats(flags);
	const oldId = need(pos, 0, 'module id');
	const out = renameModule(ws, store, oldId, need(pos, 1, 'new module id'));
	if (flags.json) { emit(JSON.stringify(out)); return 0; }
	if (!out.renamed) { console.log(`✔ ${oldId} — already named that, nothing to do`); return 0; }
	console.log(`✔ ${oldId} → ${out.id}`);
	console.log(`  rewrote  ${out.rewrites} reference(s): extends, dependencies, disable and modules/${oldId} refs`);
	console.log('✔ compiled — the rename is live, in ONE commit');
	reportCommits(out.commits);
	return 0;
}

// `dreamteamer set modules/hr description="…" dependencies=modules/core`
function metaModulesSet(ws, store, flags, pos) {
	refuseRepeats(flags);
	const id = need(pos, 0, 'module id');
	const changes = { ...pairs(pos.slice(1)), ...stripMeta(flags) };
	if (!Object.keys(changes).length) throw new Error('nothing to set — pass key=value pairs (description, dependencies, peerDependencies)');
	const out = setModule(ws, store, id, changes);
	if (flags.json) { emit(JSON.stringify(out)); return 0; }
	console.log(`✔ ${rel(ws.root, out.file)} — ${out.changed.join(', ')}`);
	console.log('✔ compiled — the module record is up to date');
	reportCommits(out.commits);
	return 0;
}

/** How many kind folders `add modules` scaffolds, for its own report. Read off the engine's own
 *  KINDS so the sentence cannot go stale against the list it describes. */
const KIND_COUNT = KINDS.length;

/** The plan line every destructive verb prints, one shape: `records N · refs M · descriptors K ·
 *  values cleared V`. ONE format, because a reader comparing two dry runs must not have to work out
 *  whether a missing term means zero or means "this verb does not count that". */
function planLine(plan) {
	return `  records ${plan.records ?? 0} · refs ${plan.refs ?? 0} · descriptors ${plan.descriptors ?? 0} · values cleared ${plan.cleared ?? 0}`;
}

/**
 * WHERE the schema change landed. ONE printer, because §9's whole point is that the answer is not
 * always "here": a write into a git-shape module commits in that clone, and the operator has to be
 * told — otherwise the change is in a repo they have not pushed and nothing said so.
 *
 * The workspace gets no "ahead" count on purpose: pushing the workspace is a thing the operator
 * already thinks about, and a number beside it would read as a new obligation.
 */
function reportCommits(commits) {
	for (const c of commits ?? []) {
		if (c.repo === '.') {
			console.log(`✔ committed in the workspace${c.sha ? ` (${c.sha})` : ''}`);
			continue;
		}
		const parts = [c.sha, c.ahead ? `ahead ${c.ahead} — push when ready` : null].filter(Boolean);
		console.log(`✔ committed in ${c.repo}${parts.length ? ` (${parts.join(', ')})` : ''}`);
	}
}

// `dreamteamer collections add --name research-docs --template docs`
function metaCollectionsAdd(ws, store, flags) {
	refuseRepeats(flags);
	// ⚠ BEFORE the write, not after. `--namespace=` is the empty STRING (clear it); a bare
	// `--namespace` parses as `true`, which is a mistake worth naming — and naming it AFTER the call
	// lands a committed collection and then exits 1, which is the one report shape that lies twice.
	if (flags.namespace === true) throw new Error("--namespace takes a value; --namespace '' means no namespace");
	const moduleId = oneValue(flags, 'module');
	const out = createCollection(ws, store, {
		name: oneValue(flags, 'name'),
		template: oneValue(flags, 'template'),
		namespace: flags.namespace,
		moduleId,
	});
	console.log(`✔ ${out.name}${out.inferred ? ` (namespace inferred from module ${moduleId})` : ''}`);
	console.log(`✔ ${rel(ws.root, out.file)}`);
	if (out.declaredNamespace) console.log(`✔ declared namespace "${out.declaredNamespace}" in ${moduleId ? `modules/${moduleId}` : 'the workspace'}`);
	console.log('✔ compiled — the collection is live (schema ops prove sources with a real compile)');
	reportCommits(out.commits);
	return 0;
}

/**
 * `dt set collections/<c> module=<m>` — the MOVE — or the collection-level scalars.
 *
 * ⚠ Never both in one call. `module=` relocates a descriptor and validates the whole reference
 * contract; a scalar rewrites one key in it. Bundling them would make one command that either
 * half-applies or has to be explained, and the operator gets no signal about which happened.
 */
function metaCollectionsSet(ws, store, flags, pos) {
	refuseRepeats(flags);
	const name = need(pos, 0, 'collection name');
	const positional = pairs(pos.slice(1));
	const changes = { ...positional, ...stripMeta(flags) };
	delete changes.module;
	delete changes['dry-run'];
	const moveTo = positional.module ?? oneValue(flags, 'module');
	if (moveTo !== undefined && Object.keys(changes).length) {
		throw new Error(`module= moves the collection to another module and validates the whole reference contract; a scalar rewrites one key in its descriptor. Run them as two commands: dreamteamer set collections/${name} module=${moveTo}, then dreamteamer set collections/${name} ${Object.entries(changes).map(([k, v]) => `${k}=${v}`).join(' ')}`);
	}
	if (moveTo !== undefined) {
		const out = moveCollection(ws, store, name, String(moveTo), { dryRun: !!flags['dry-run'] });
		if (flags.json) { emit(JSON.stringify(out)); return 0; }
		if (out.dryRun) {
			console.log(`dry run — dreamteamer set collections/${name} module=${moveTo} would:`);
			console.log(planLine(out));
			console.log(`  descriptor  ${out.from} → ${out.to} (records stay where they are)`);
			return 0;
		}
		if (!out.moved) { console.log(`✔ ${name} — already owned by ${out.from}, nothing to do`); return 0; }
		console.log(`✔ ${name}: ${out.from} → ${out.to}`);
		console.log(`  records     ${out.records} left in place — a move never changes an id`);
		console.log(`  descriptors ${out.descriptors} rewritten`);
		console.log('✔ compiled — the move is live, in ONE commit');
		reportCommits(out.commits);
		return 0;
	}
	if (!Object.keys(changes).length) throw new Error('nothing to set — pass key=value pairs, or module=<id> to move it');
	const out = setCollectionScalars(ws, store, name, changes, { moduleId: undefined });
	if (flags.json) { emit(JSON.stringify(out)); return 0; }
	console.log(`✔ ${rel(ws.root, out.file)} — ${out.changed.join(', ')}`);
	console.log('✔ compiled — the descriptor is up to date');
	reportCommits(out.commits);
	return 0;
}

/** `dt get collections/<c> --module <m>` — ONE module's source contribution, not the merged
 *  descriptor. The merged one is what `dt get collections/<c>` prints and what every reader uses;
 *  this is the only way to see what a given module actually wrote, which is the question an overlay
 *  makes unanswerable from the runtime alone. */
function metaCollectionsGet(ws, store, flags, pos) {
	refuseRepeats(flags);
	const name = need(pos, 0, 'collection name');
	const moduleId = oneValue(flags, 'module');
	const { file } = collectionSourceFileFor(ws, store, name, moduleId);
	const doc = load(fs.readFileSync(file, 'utf8'));
	flags.json ? emit(JSON.stringify({ ...doc, id: name, source: rel(ws.root, file) }, null, 2)) : console.log(dump(doc).trimEnd());
	return 0;
}

// `dreamteamer collections rename doctors health/doctors`, or `… doctors --namespace health`.
// The whole point is that namespacing EXISTING data is one command instead of a six-step hand
// migration whose last step (rewriting references) dangles everything when forgotten.
function metaCollectionsRename(ws, store, flags, pos) {
	refuseRepeats(flags);
	const [oldName, explicitNew] = pos;
	if (!oldName) throw new Error('usage: dreamteamer rename collections/<old> <new> | collections/<old> --namespace <ns>');
	// `--namespace health` on its own moves the collection INTO that namespace keeping its bare name,
	// which is the common case and saves retyping it.
	const newName = explicitNew
		?? (flags.namespace ? `${String(flags.namespace).replace(/^\/+|\/+$/g, '')}/${baseNameOf(oldName, store.namespaces)}` : null);
	if (!newName) throw new Error('missing new name — give it positionally or with --namespace <ns>');

	if (flags['dry-run']) {
		const d = store.descriptor(oldName);
		const records = store.ids(oldName).size;
		console.log(`dry run — dreamteamer rename collections/${oldName} ${newName} would:`);
		console.log(planLine({ records, refs: 0, descriptors: 1, cleared: 0 }));
		console.log(`  records  ${d.storage.path} → ${defaultStoragePath(newName, store.namespaces, ws.pkg.dreamteamer?.['data-path'] ?? 'data')}`);
		// ⚠ `refs` is honestly 0 here and the line says so. Counting them would mean running the batch
		// rewrite to find out, which IS the op — and a number the plan cannot know is worse than a
		// stated gap: the plan line has a fixed shape precisely so a reader never has to guess whether
		// a term is zero or unmeasured.
		console.log('  refs are counted only by the real run — the rewrite is what discovers them');
		return 0;
	}
	const out = renameCollection(ws, store, oldName, newName);
	if (flags.json) { emit(JSON.stringify(out)); return 0; }
	if (!out.renamed) { console.log(`✔ ${oldName} — already named that, nothing to do`); return 0; }
	console.log(`✔ ${oldName} → ${out.name}`);
	if (out.from !== out.to) console.log(`  records  ${out.from} → ${out.to} (${out.records})`);
	if (out.suffix) console.log(`  suffix   .${out.suffix.from}.md → .${out.suffix.to}.md`);
	if (out.pathKept) console.log(`  ⚠ storage.path kept as "${out.pathKept}" — it was authored, so the rename did not overrule it`);
	console.log(`  refs     ${out.rewrites} rewritten`);
	console.log('✔ compiled — the rename is live, in ONE commit');
	reportCommits(out.commits);
	return 0;
}

// `dreamteamer collections rm widgets [--force]` — --force is required to drop a collection
// that still has records (removeCollection refuses otherwise, and says so).
function metaCollectionsRm(ws, store, flags, pos) {
	refuseRepeats(flags);
	const name = need(pos, 0, 'collection name');
	const out = removeCollection(ws, store, name, { force: !!flags.force });
	flags.json ? emit(JSON.stringify(out)) : console.log(`✔ removed collection ${out.removed}`);
	console.log('✔ compiled — the collection is gone');
	reportCommits(out.commits);
	return 0;
}

// `dreamteamer tasks add-field --name urgent --type boolean --default-value false`
function metaAddField(ws, store, collection, flags) {
	refuseRepeats(flags);
	const prop = fieldDef(store, flags, collection);
	// fieldDef DEFERS every relation flag it has no reference to attach to, because on update-field
	// the target is carried in afterwards. add-field has nothing to carry, so a relation flag that
	// landed nowhere is a mistake — refused here rather than written as a dead keyword.
	const stray = (prop.items ?? prop)['x-reference'] === undefined && relationFlagsStated(flags);
	if (stray) throw new Error(`--${stray} needs a --type <collection> reference.`);
	const out = addField(ws, store, collection, { name: flags.name, prop, required: flags.required === 'true', moduleId: oneValue(flags, 'module') });
	if (out.unchanged) return alreadyThat(collection, flags.name);
	console.log(`✔ ${rel(ws.root, out.file)}${out.extends ? ` (extends ${out.extends})` : ''}`);
	console.log('✔ compiled — the field is live');
	reportCommits(out.commits);
	reportMirror(store, collection, flags.name, out.prop);
	reportDropped(out.dropped);
	return 0;
}

/** The idempotent answer, in `rename-collection`'s words — a command that asks for what is already
 *  there succeeded, and the operator needs to know which field it was talking about. */
function alreadyThat(collection, field) {
	console.log(`✔ ${collection}.${field} — already exactly that, nothing to do`);
	return 0;
}

/** The other consequence a schema op can have on DATA: removing a relation leaves the values its
 *  mirror generated in every target record, in a field the schema no longer declares. The op cleans
 *  them up in its own commit (schema-ops `dropOrphanedMirrors`) — this says how many, because an
 *  operator told a mirror is gone needs to know records changed with it. */
function reportDropped(dropped) {
	for (const { target, mirror, records } of dropped ?? []) {
		console.log(`  dropped the generated ${target}.${mirror} value from ${records} ${target} record${records === 1 ? '' : 's'}`);
	}
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
	refuseRepeats(flags);
	if (!flags.name) throw new Error('missing --name <field>');
	const prop = fieldDef(store, flags, collection);
	// tri-state: omitting --required leaves requiredness ALONE, rather than silently clearing it
	const required = flags.required === undefined ? undefined : flags.required === 'true' || flags.required === true;
	// `flags` for the VALUES and `stated` for what the caller meant to restate: updateField carries
	// every unstated relation keyword forward from the previous prop.
	const out = updateField(ws, store, collection, flags.name, { prop, required, flags, stated: statedKeywords(flags), moduleId: oneValue(flags, 'module') });
	if (out.unchanged) return alreadyThat(collection, flags.name);
	console.log(`✔ ${rel(ws.root, out.file)}${out.extends ? ` (extends ${out.extends})` : ''}`);
	console.log('✔ compiled — the field is updated');
	reportCommits(out.commits);
	reportDropped(out.dropped);
	// off `out.prop`, never the one passed in: updateField reassigns it when it rebuilds a carried
	// reference as an array, and reporting off the stale object printed nothing on exactly the
	// migration path where check fails on the very next command.
	reportMirror(store, collection, flags.name, out.prop);
	return 0;
}

// `dreamteamer tasks remove-field --name urgent`
function metaRemoveField(ws, store, collection, flags) {
	refuseRepeats(flags);
	const name = flags.name ?? flags.field;
	if (!name) throw new Error('missing --name <field>');
	const moduleId = oneValue(flags, 'module');
	if (flags['dry-run']) {
		const plan = removeFieldPlan(store, collection, name);
		console.log(`dry run — dreamteamer remove-field ${collection} --name ${name} would:`);
		console.log(planLine(plan));
		if (plan.staleViews.length) console.log(`  ui-views still listing it as a column: ${plan.staleViews.join(', ')}`);
		return 0;
	}
	const out = removeField(ws, store, collection, name, { moduleId });
	flags.json ? emit(JSON.stringify(out)) : console.log(`✔ removed field ${collection}.${out.removed}`);
	console.log('✔ compiled — the field is gone');
	reportCommits(out.commits);
	if (!flags.json) {
		// The field's own VALUES went with it, and that has to be said out loud: it is the destructive
		// half of a destructive verb, and a silent deletion is a different act from a reported one.
		if (out.cleared) console.log(`  cleared its values from ${out.cleared} ${collection} record${out.cleared === 1 ? '' : 's'} (git holds them: git show HEAD~1)`);
		reportDropped(out.dropped);
		// This descriptor's own `list_fields`/`sort_field` were pruned with the field; a ui-view is a
		// source this verb does not own, so it is NAMED rather than edited — and naming it is the whole
		// point, since a column of a field that no longer exists renders as an empty one.
		if (out.staleViews?.length) console.warn(`⚠ still listing ${collection}.${name} as a column: ${out.staleViews.join(', ')} — edit with \`dreamteamer set ui-views/<id> options.columns=…\``);
	}
	return 0;
}

const ENTITY_KINDS = new Set(['skills', 'agents', 'commands', 'command-bindings', 'collection-templates']);
const SCAFFOLDABLE = new Set(['skills']);

function metaEntityVerb(ws, store, kind, verb, flags, pos) {
	refuseRepeats(flags);
	const one = kind.replace(/s$/, '');
	if (verb === 'add') {
		const name = oneValue(flags, 'name');
		if (!SCAFFOLDABLE.has(kind)) refuseHandAuthored(ws, store, kind, name, oneValue(flags, 'module'));
		const out = createSkill(ws, store, {
			name,
			description: oneValue(flags, 'description'),
			moduleId: oneValue(flags, 'module'),
		});
		if (flags.json) { emit(JSON.stringify(out)); return 0; }
		console.log(`✔ ${rel(ws.root, out.file)}`);
		console.log('✔ compiled — the skill is live (write its body next; the frontmatter is the trigger)');
		reportCommits(out.commits);
		return 0;
	}
	if (verb === 'rm') {
		const out = removeEntity(ws, store, kind, need(pos, 0, `${one} id`));
		if (flags.json) { emit(JSON.stringify(out)); return 0; }
		console.log(`✔ removed ${one} ${out.removed}`);
		console.log('✔ compiled — it is gone');
		reportCommits(out.commits);
		return 0;
	}
	if (verb === 'rename') {
		const oldId = need(pos, 0, `${one} id`);
		const out = renameEntity(ws, store, kind, oldId, need(pos, 1, 'new id'));
		if (flags.json) { emit(JSON.stringify(out)); return 0; }
		if (!out.renamed) { console.log(`✔ ${oldId} — already named that, nothing to do`); return 0; }
		console.log(`✔ ${kind}/${oldId} → ${kind}/${out.id}`);
		console.log('✔ compiled — the rename is live');
		reportCommits(out.commits);
		return 0;
	}
	const id = need(pos, 0, `${one} id`);
	const changes = { ...pairs(pos.slice(1)), ...stripMeta(flags) };
	if (!Object.keys(changes).length) throw new Error(`nothing to set — pass key=value pairs (a ${one}'s frontmatter keys)`);
	const out = setEntityFrontmatter(ws, store, kind, id, changes);
	if (flags.json) { emit(JSON.stringify(out)); return 0; }
	console.log(`✔ ${rel(ws.root, out.file)} — ${out.changed.join(', ')}`);
	console.log('✔ compiled — the change is live');
	reportCommits(out.commits);
	return 0;
}

/** The path `revert`'s refusal names — where a human edits this compiled entity. */
function sourceHintFor(store, collection) {
	const d = store.descriptors.get(collection);
	return d?.storage?.path ? `modules/*/${d.storage.path}/` : `modules/*/${collection}/`;
}

// `dreamteamer rename-field people --name employer --to company`
function metaRenameField(ws, store, collection, flags) {
	refuseRepeats(flags);
	const from = oneValue(flags, 'name') ?? oneValue(flags, 'field');
	if (!from) throw new Error(`missing --name <field>: dreamteamer rename-field ${collection} --name <field> --to <new-name>`);
	const to = oneValue(flags, 'to');
	if (flags['dry-run']) {
		const plan = renameFieldPlan(store, collection, from);
		console.log(`dry run — dreamteamer rename-field ${collection} --name ${from} --to ${to ?? '<new-name>'} would:`);
		console.log(planLine(plan));
		// ⚠ The same honesty the `rename collections` dry run needs, for the same reason: a number the
		// plan cannot know is worse than a stated gap.
		console.log('  descriptors, ui-views and command-bindings naming it are counted by the real run —');
		console.log('  the rewrite is what discovers which of them carry the name');
		return 0;
	}
	const out = renameField(ws, store, collection, from, to, { moduleId: oneValue(flags, 'module') });
	if (flags.json) { emit(JSON.stringify(out)); return 0; }
	if (!out.renamed) { console.log(`✔ ${collection}.${from} — already named that, nothing to do`); return 0; }
	console.log(`✔ ${collection}.${out.from} → ${collection}.${out.to}`);
	console.log(`  records  ${out.records} rewritten`);
	for (const f of out.surfaces) console.log(`  source   ${f}`);
	console.log('✔ compiled — the rename is live, in ONE commit');
	reportCommits(out.commits);
	return 0;
}

// ---- ui-views ---------------------------------------------------------------------------------
// A view is an ordinary record conceptually (decision 49) but a SYSTEM-stored one, so it goes
// through saveUiView's compile gate rather than the record store. Without these verbs everything
// the Layout options panel does — columns, order, sort, layout, filter, nav — was click-only.

/**
 * Layout options whose value is a LIST, so `options.columns=title,status` means what it says.
 *
 * ⚠ NAMED, not inferred, and that is the whole design: `options` is an open bag with no schema —
 * each layout declares its own keys and unknown ones ride through untouched — so nothing in the
 * runtime can tell a list key from a scalar one. Without this set the comma spelling every other
 * verb accepts for an array (`--tags a,b`) stored the literal string `"title,status"`, which the
 * surface reads with `Array.isArray` and therefore ignores: a view that looked configured, drew
 * the descriptor's `list_fields` instead, and reported nothing anywhere.
 *
 * `columns` is honoured by every layout; `ref_fields` and `value_fields` are the diagram's
 * link-by pickers. `arrangement` is deliberately ABSENT — its elements are objects, so the JSON
 * form is its only honest spelling, and a comma split would quietly produce garbage.
 */
const VIEW_LIST_OPTIONS = new Set(['options.columns', 'options.ref_fields', 'options.value_fields']);

/** `--options '{"sort":"-date"}'` style flags, plus dotted `options.sort=-date` positionals. The
 *  KEY is passed because the value's shape depends on it: only the key says whether a comma is a
 *  separator or a character. */
function parseViewValue(raw, key) {
	if (typeof raw !== 'string') return raw;
	const t = raw.trim();
	if (t === 'true') return true;
	if (t === 'false') return false;
	if (t !== '' && !Number.isNaN(Number(t))) return Number(t);
	if (t.startsWith('{') || t.startsWith('[')) {
		try { return JSON.parse(t); } catch { throw new Error(`not valid JSON: ${t}`); }
	}
	// ⚠ A QUOTED value is a LITERAL string, and `options.sort='""'` is the whole reason the branch
	// exists: `sort: ''` is what the surface requires to round-trip "unsorted" (omit it and the
	// ordering silently reverts to a fallback on the next load), and the dotted grammar could not
	// express it — an empty value UNSETS, by the same convention `dt set` has for a record field.
	// So the quoting is the operator saying "the empty string IS the value"; `assignViewValue`
	// carries that through to `assignPath`.
	if (t.startsWith('"')) {
		try {
			const s = JSON.parse(t);
			if (typeof s === 'string') return s;
		} catch { /* one message for every malformed quoting, below */ }
		throw new Error(`not a quoted string: ${t} — a literal is written like '"-date"' (and '""' for the empty one)`);
	}
	// An empty value falls through to assignPath, which UNSETS the key — a `columns=` that wrote
	// `columns: []` would be a configured-to-show-nothing view, not a removed setting.
	if (t !== '' && VIEW_LIST_OPTIONS.has(key)) return t.split(',').map((s) => s.trim()).filter(Boolean);
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
 *
 * `explicit` is the escape hatch, and it has exactly one caller: a value the operator QUOTED
 * (`options.sort='""'`) is a value, empty or not. Without it the convention above has no exception
 * and `sort: ''` — which the surface needs to mean "unsorted" — is unwritable from the CLI.
 */
function assignPath(target, dotted, value, explicit = false) {
	const keys = dotted.split('.');
	const leaf = keys[keys.length - 1];
	const unset = !explicit && (value === null || value === '');
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

/** One dotted `key=value` write into a view: the value grammar, plus the one signal `assignPath`
 *  cannot recover from the parsed value — whether the operator quoted it. */
function assignViewValue(view, key, raw) {
	assignPath(view, key, parseViewValue(raw, key), typeof raw === 'string' && raw.trim().startsWith('"'));
}

const VIEW_META_FLAGS = new Set(['id', 'json', 'force']);

function metaUiView(ws, store, verb, flags, pos) {
	if (verb === 'rm') {
		const out = removeUiView(ws, store, need(pos, 0, 'ui-view id'));
		flags.json ? emit(JSON.stringify(out)) : console.log(`✔ removed ui-view ${out.removed}`);
		console.log('✔ compiled — the route is gone');
		reportCommits(out.commits);
		return 0;
	}

	// `set` edits what the record already says; `add` starts from nothing. Reading through the
	// store means `set` works on a MODULE-shipped view too — the edit lands as a workspace source
	// that shadows it, which is the same thing saving one in the UI does.
	let view = {};
	let id = oneValue(flags, 'id');
	if (verb === 'set') {
		id ??= need(pos, 0, 'ui-view id');
		const { fields } = store.read('ui-views', id);
		view = JSON.parse(JSON.stringify(fields));
		delete view.id; // the id is the filename, never a body key
	}

	for (const p of pos.slice(verb === 'set' ? 1 : 0)) {
		if (!p.includes('=')) continue;
		assignViewValue(view, p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1));
	}
	for (const [k, v] of Object.entries(flags)) {
		if (VIEW_META_FLAGS.has(k)) continue;
		// A view key holds ONE value, and a list IS one value — so a repeated flag is a mistake with
		// two spellings to correct it, rather than an array nobody asked for.
		if (Array.isArray(v)) {
			throw new Error(`--${k} was given ${v.length} times — a view key takes one value, and a list is written as one: --${k} ${v.join(',')} (or the JSON form '${JSON.stringify(v)}')`);
		}
		assignViewValue(view, k, v);
	}

	if (!view.path) throw new Error('missing --path </route> — a view is addressed by its route');
	// same id rule the descriptor declares (`{{ path | slug }}`) and the UI derives, so a view
	// saved from the CLI and one saved from the panel land on the SAME record.
	id ??= slug(view.path);

	const out = saveUiView(ws, store, { id, view });
	flags.json ? emit(JSON.stringify(out)) : console.log(`✔ ${rel(ws.root, out.file)}`);
	console.log(`✔ compiled — ${view.path} is live`);
	reportCommits(out.commits);
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
	// The name is VALIDATED, exactly as `rebuild` validates it: without this a typo answered "no
	// two-way relations touch nosuch" at exit 0 — the same sentence a correctly-spelled collection
	// with no relations gets, so a misspelling reads as a fact about the workspace.
	if (pos[0]) store.descriptor(pos[0]);
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

/**
 * `--flag value`, `--flag=value`, a bare `--flag` (true), and positionals.
 *
 * ⚠ A REPEATED flag PROMOTES TO AN ARRAY; it does not overwrite. `dt add c --tags a --tags b`
 * assigned twice and kept `b`, so the first value never reached disk and nothing said so — the
 * shape of every silent-wrong-answer bug this CLI has had. The promotion is the only honest parse,
 * because "the operator typed it twice" is a fact the parser cannot interpret on its own.
 *
 * Every consumer of a flag therefore owes an answer to "what does a repeat MEAN here", and there
 * are exactly three: it is one ELEMENT of an array field (`coerceArrays`), it is one more
 * conjunctive CONDITION (`--filter`, in list), or the flag holds one value and a repeat is a
 * MISTAKE (`oneValue`, and the view writer). Silence is not one of them.
 */
export function parseArgs(args) {
	const flags = {};
	const pos = [];
	const put = (k, v) => { flags[k] = k in flags ? [].concat(flags[k], v) : v; };
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a.startsWith('--')) {
			const eq = a.indexOf('=');
			if (eq > -1) put(a.slice(2, eq), a.slice(eq + 1));
			else if (i + 1 < args.length && !args[i + 1].startsWith('--')) put(a.slice(2), args[++i]);
			else put(a.slice(2), true);
		} else pos.push(a);
	}
	return { flags, pos };
}

/** Read a flag that takes exactly ONE value. A repeat arrives as an array, and dropping it on the
 *  floor (`typeof v === 'string'` reads an array as absent) would answer the wrong question at exit
 *  0 — so it is named instead, with the line that was typed. */
function oneValue(flags, key) {
	const v = flags[key];
	if (Array.isArray(v)) {
		throw new Error(`--${key} was given ${v.length} times and takes ONE value: ${v.map((x) => `--${key} ${x}`).join(' ')}`);
	}
	return typeof v === 'string' ? v : undefined;
}

/**
 * A schema verb takes ONE value per flag, and a repeat is refused before anything is written.
 *
 * None of them means a list by repetition — `--options a,b` is one value, and `--name` names the
 * single thing being written — so every repeat is a mistake. It has to be caught here because the
 * ones that matter are IDENTITY: `--name x --name y` wrote a field called `y` before the promotion
 * and one called `x,y` after it, and both of those are a source file the operator then has to find
 * and edit by hand.
 */
function refuseRepeats(flags) {
	const dup = Object.entries(flags).find(([, v]) => Array.isArray(v));
	if (!dup) return;
	const [k, v] = dup;
	throw new Error(`--${k} was given ${v.length} times, and a schema verb takes ONE value per flag: ${v.map((x) => `--${k} ${x}`).join(' ')}`);
}

/** `field=value` positionals, with the same promote-on-repeat rule the flags have. It was
 *  `Object.fromEntries`, which keeps the LAST pair — `dt set c/id tags=a tags=b` wrote `[b]`. */
function pairs(list) {
	const out = {};
	for (const p of list) {
		if (!p.includes('=')) continue;
		const k = p.slice(0, p.indexOf('='));
		const v = p.slice(p.indexOf('=') + 1);
		out[k] = k in out ? [].concat(out[k], v) : v;
	}
	return out;
}

// ⚠ `module` and `dry-run` are VERB OPTIONS on every verb that takes them, so they may never be
// read as record field names. A collection wanting a field literally called `module` writes it as
// `module=<v>` positionally, which `pairs()` reads and `stripMeta` never sees.
const META_FLAGS = new Set(['id', 'json', 'force', 'filter', 'module', 'dry-run']);
const stripMeta = (flags) => Object.fromEntries(Object.entries(flags).filter(([k]) => !META_FLAGS.has(k)));

// CLI values are strings; split comma-lists for array-typed fields (ajv coerces the rest)
function coerceArrays(d, fields) {
	const out = {};
	for (const [k, v] of Object.entries(fields)) {
		const isList = d.schema.properties?.[k]?.type === 'array';
		// An array here means the operator SPELLED the key twice (`--tags a --tags b`, or
		// `tags=a tags=b`). On a list field each sighting is one element — deliberately NOT
		// comma-split again, so a value that contains a comma can be written by repeating the flag.
		if (Array.isArray(v)) {
			if (!isList) {
				throw new Error(`${k} was given ${v.length} times (--${k} <value> / ${k}=<value>) and ${k} is not an array field — pass it once`);
			}
			out[k] = v;
			continue;
		}
		out[k] = isList && typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v;
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
