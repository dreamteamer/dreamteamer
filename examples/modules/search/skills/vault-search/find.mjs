#!/usr/bin/env node
// vault-search — full-text search over every record, as refs. A MODULE SCRIPT (see the engine's
// building-dreamteamer → references/module-scripts.md): it imports the workspace's PINNED engine,
// reads records through the Store, and owns nothing but its gitignored .cache/.
//
//   node modules/search/skills/vault-search/find.mjs "<query>" \
//        [--collection <c>] [--where '<json>'] [--limit N] [--json] [--rebuild]
//
// The bare `dreamteamer` import resolves against the workspace's node_modules (including the
// symlink/install channels the engine's own bin uses) — script and engine version travel together.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findWorkspace } from 'dreamteamer/src/workspace.js';
import { Store, bodyField } from 'dreamteamer/src/store.js';
import { matchesFilter } from 'dreamteamer/src/filter.js';
import { recordResolver } from 'dreamteamer/src/record-commands.js';

// node:sqlite ships FTS5 and needs no install, but only from Node 22.13 (flag-free). Fail loudly,
// name the fix — a module script degrades by refusing, never by guessing.
let DatabaseSync;
try {
	({ DatabaseSync } = await import('node:sqlite'));
} catch {
	console.error(`✖ vault-search needs node:sqlite (Node >= 22.13); this is ${process.version}`);
	process.exit(1);
}

const VALUE_FLAGS = new Set(['collection', 'where', 'limit']);
let query;
const flags = {};
for (let i = 2; i < process.argv.length; i++) {
	const a = process.argv[i];
	if (a.startsWith('--')) { const n = a.slice(2); flags[n] = VALUE_FLAGS.has(n) ? process.argv[++i] : true; }
	else query ??= a;
}
if (!query) {
	console.error('usage: find.mjs "<query>" [--collection <c>] [--where <json>] [--limit N] [--json] [--rebuild]');
	process.exit(1);
}
const has = (name) => flags[name] === true;
const limit = Number(flags.limit ?? 10);
const onlyCollection = flags.collection;
const where = flags.where ? JSON.parse(flags.where) : null;

const started = performance.now();
const ws = findWorkspace();
const store = new Store(ws);
const CACHE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.cache');
fs.mkdirSync(CACHE, { recursive: true });
const db = new DatabaseSync(path.join(CACHE, 'index.sqlite'));

// ---- staleness: same heuristic as the store's ids cache (HEAD + data-dir mtimes), same honest
// gap — a deep hand edit that moves neither can serve one stale search. Tool writes always commit.
const dataCollections = [...store.descriptors.values()].filter((d) => d.storage.base !== 'runtime');
const head = (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ws.root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return 'no-git'; } })();
const mtimes = dataCollections.map((d) => { try { return fs.statSync(store.dir(d)).mtimeMs; } catch { return 0; } });
const key = `${head}:${mtimes.join(',')}`;

db.exec(`create table if not exists meta(k text primary key, v text)`);
const current = db.prepare(`select v from meta where k = 'key'`).get()?.v;
if (current !== key || has('rebuild')) {
	db.exec(`drop table if exists hits;
		create virtual table hits using fts5(collection unindexed, id unindexed, title, fm, body, tokenize='porter unicode61')`);
	const ins = db.prepare(`insert into hits(collection, id, title, fm, body) values (?, ?, ?, ?, ?)`);
	db.exec('begin');
	for (const d of dataCollections) {
		const bf = bodyField(d);
		for (const { id, fields } of store.readAll(d.name)) {
			const fm = Object.entries(fields)
				.filter(([k, v]) => k !== bf && v != null && typeof v !== 'object')
				.map(([k, v]) => `${k}: ${v}`).join('\n');
			ins.run(d.name, id, String(fields.title ?? fields.name ?? id), fm, String((bf && fields[bf]) ?? ''));
		}
	}
	db.exec('commit');
	db.prepare(`insert into meta(k, v) values ('key', ?) on conflict(k) do update set v = excluded.v`).run(key);
}

// ---- query: terms OR-ed and bm25-ranked — the caller (usually an agent) is the query expander,
// so one matching probe term must be enough to hit, and more must rank higher.
const match = query.split(/\s+/).filter(Boolean).map((t) => `"${t.replaceAll('"', '""')}"`).join(' OR ');
let rows = db.prepare(`
	select collection, id, snippet(hits, 4, '', '', '…', 12) as snippet, bm25(hits) as rank
	from hits where hits match ? ${onlyCollection ? 'and collection = ?' : ''}
	order by rank limit ?`).all(...(onlyCollection ? [match, onlyCollection, limit * 5] : [match, limit * 5]));

// typed filtering through the engine's OWN matchesFilter — `--where` means exactly what it means
// on `dt <c> list`, one operator set, one implementation.
if (where) {
	const resolve = recordResolver(store);
	rows = rows.filter((r) => {
		try { const { fields } = store.read(r.collection, r.id); return matchesFilter({ ...fields, id: r.id }, where, resolve); }
		catch { return false; }
	});
}
rows = rows.slice(0, limit);

const ms = Math.round(performance.now() - started);
fs.appendFileSync(path.join(CACHE, 'usage.log'), JSON.stringify({ ts: new Date().toISOString(), query, hits: rows.length, ms }) + '\n');

if (has('json')) console.log(JSON.stringify(rows.map(({ collection, id, snippet }) => ({ ref: `${collection}/${id}`, collection, id, snippet })), null, 2));
else if (!rows.length) { console.log(`no hits for "${query}" — try other words for the same thing; each probe is cheap`); process.exit(1); }
else for (const r of rows) console.log(`${r.collection}/${r.id}\t${r.snippet.replaceAll('\n', ' ')}`);
