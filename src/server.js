// dreamteamer server — the CLEAN REST contract over the same validating store the
// CLI uses (decision #16: nothing Directus-flavored lives here; the studio's api
// client carries the one transitional adapter). serves the built studio at /admin.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import express from 'express';
import { Store, bodyField } from './store.js';
import { readManifest, staleness, discoverModules, CompileError } from './compile.js';
import { presentation } from './presentation.js';
import {
	createCollection, removeCollection, addField, updateField, removeField, fieldDef, statedKeywords, saveUiView, removeUiView,
	// ⚠ The names above are IMPORTED IN-PROCESS by the VS Code extension and must never change; the
	// new capabilities are new exports beside them (CLAUDE.md — a rename is a cross-repo activation
	// failure).
	createModule, removeModule, setModule, moveCollection, setCollectionScalars, renameField,
	createSkill, refuseHandAuthored, removeEntity, setEntityFrontmatter,
} from './schema-ops.js';
import { history, historyDiff } from './history.js';
import { matchesFilter } from './filter.js';
import { sortRows } from './temporal.js';
import { placementKey } from './fractional-index.js';
import { commandsFor, recordResolver } from './record-commands.js';
import { distinctValues } from './field-values.js';


export function startServer(ws, { port = 8080, host = '127.0.0.1' } = {}) {
	const app = express();
	app.use(express.json({ limit: '10mb' }));

	// a fresh Store per mutating request would be wasteful; per-process with manual
	// reload on demand is enough for a local single-operator server (RAD).
	let store = new Store(ws);
	const reload = () => { store = new Store(ws); };

	// review finding 9: descriptors loaded once per process made `compile` invisible to a
	// running server. cheap fix: stat the manifest per request, rebuild the Store when it moved.
	const manifestPath = path.join(ws.root, '.dreamteamer', 'manifest.yaml');
	let manifestMtime = fs.existsSync(manifestPath) ? fs.statSync(manifestPath).mtimeMs : 0;
	const freshStore = () => {
		const m = fs.existsSync(manifestPath) ? fs.statSync(manifestPath).mtimeMs : 0;
		if (m !== manifestMtime) { manifestMtime = m; reload(); }
		return store;
	};

	const api = express.Router();
	api.use((req, res, next) => { freshStore(); next(); });

	// ⚠ NO `user` on /info since 0.8.0, and no `@me` — both went with the `users` collection. The
	// token expanded to the literal string `users/<slug of git user.name>`, so with no such
	// collection it could only ever produce a dangling reference. A workspace that wants
	// operator-scoped views filters on a field it owns.
	api.get('/info', (req, res) => {
		const manifest = readManifest(ws.root);
		const stale = staleness(ws.root);
		res.json({
			name: ws.pkg.name,
			host: manifest?.host,
			compiled: manifest?.compiled,
			modules: manifest?.modules ?? [],
			ui: manifest?.ui ?? [], // module UI bundles staged at /ui/<name>/app.js
			stale: stale.stale?.length ?? 0,
			collections: [...store.descriptors.keys()],
		});
	});

	api.get('/schema', (req, res) => {
		res.json([...store.descriptors.values()].sort((a, b) => (a.order ?? 999) - (b.order ?? 999)));
	});

	// ⚠ A NAMESPACED COLLECTION NAME CONTAINS A SLASH (`health/doctors`), and `:name` is one path
	// segment — so a client MUST percent-encode it: `/collections/health%2Fdoctors/records`. Express
	// matches on the still-encoded path and decodes params afterwards, so `req.params.name` arrives as
	// `health/doctors` and every route below works unchanged.
	//
	// The alternative was `*name`, and it is wrong: `/collections/*name/records/*id` puts a greedy
	// wildcard, a literal and a second wildcard in one pattern, so `/collections/a/b/records/c` has
	// several readings and the router picks one. Encoding keeps the boundary explicit at the caller,
	// which is the same reason references declare their namespace instead of having it inferred.
	api.get('/collections/:name/records', (req, res) => {
		const d = store.descriptor(req.params.name);
		const bf = bodyField(d);
		const { limit = 200, offset = 0, sort, q, filter, ...rest } = req.query;
		const modified = gitModifiedMap(ws.root, store.dir(d));
		let rows = [];
		for (const { id, file, fields } of store.readAll(req.params.name)) {
			rows.push({ ...fields, id, 'last-modified': modified.get(path.relative(ws.root, file)) ?? null }); // record id WINS over any schema field named "id"
		}
		// rich filter: ?filter=<json> — Directus-style operators (_eq/_contains/_and/...)
		// + one-hop relational conditions (tier 1) via the memoized resolver
		if (filter) {
			const f = typeof filter === 'string' ? JSON.parse(filter) : filter;
			const resolve = recordResolver(store);
			rows = rows.filter((r) => matchesFilter(r, f, resolve));
		}
		// simple equality: filter[field]=value or bare field=value
		for (const [k, v] of Object.entries(rest)) {
			const key = k.startsWith('filter[') ? k.slice(7, -1) : k;
			rows = rows.filter((r) => String(r[key] ?? '') === String(v));
		}
		if (q) {
			const needle = String(q).toLowerCase();
			rows = rows.filter((r) => JSON.stringify(r).toLowerCase().includes(needle));
		}
		sortRows(rows, sort);
		const total = rows.length;
		rows = rows.slice(Number(offset), Number(offset) + Number(limit));
		const wantBody = req.query['with-body'] === 'true';
		if (bf && !wantBody) for (const r of rows) delete r[bf];
		res.json({ records: rows, total });
	});

	api.get('/collections/:name/records/*id', (req, res) => {
		const { fields, file } = store.read(req.params.name, idParam(req));
		const commit = gitLastCommit(ws.root, file);
		res.json({
			id: idParam(req),
			fields: {
				...fields,
				'last-modified': commit?.date ?? null,
				'$last-modified-by': commit?.author ?? null,
				'$last-commit-message': commit?.message ?? null,
			},
			path: path.relative(ws.root, file),
		});
	});

	api.post('/collections/:name/records', (req, res) => {
		// A SYSTEM collection is a collection, and this is the one route it comes through. The store
		// still refuses the write (writableDescriptor — decision 14 is affirmed, not reversed), so the
		// branch is here, at the surface, exactly as the CLI's interceptor is.
		if (store.descriptors.get(req.params.name)?.storage?.base === 'runtime') {
			const out = systemWrite(ws, store, req);
			reload();
			return res.json(out);
		}
		const { id: explicitId, ...fields } = req.body ?? {};
		const { id, file } = store.add(req.params.name, fields, { id: explicitId });
		res.status(201).json({ id, path: path.relative(ws.root, file) });
	});

	api.patch('/collections/:name/records/*id', (req, res) => {
		if (store.descriptors.get(req.params.name)?.storage?.base === 'runtime') {
			const out = systemWrite(ws, store, req);
			reload();
			return res.json(out);
		}
		// clients may echo synthetic response keys back on save (id/path/last-modified/the two
		// $-prefixed commit-info fields) — never persist any of them.
		const { id: _id, path: _path, 'last-modified': _lm, '$last-modified-by': _lmb, '$last-commit-message': _lcm, ...changes } = req.body ?? {};
		store.set(req.params.name, idParam(req), changes);
		res.json({ id: idParam(req) });
	});

	// Manual ordering. NOT Directus's `PATCH /utils/sort/:collection` (decision #16: nothing
	// Directus-flavored lives here).
	//
	// ⚠ THE VERB COMES BEFORE THE WILDCARD, and it must. `…/records/*id` is greedy because ids are
	// PATHS, so `…/records/charlie/position` reads as the record `charlie/position` and the ordinary
	// record PATCH answers first — measured, as a 404 from a route that looked correct. Same reasoning
	// as the `*name` note above: one greedy wildcard, and it goes last.
	//
	// Key generation stays in the ENGINE, next to the comparator it has to agree with. A client that
	// computed keys itself would carry the a-z alphabet rule in a second repo, and the failure when
	// those drift is silent mis-ordering, not an error.
	api.patch('/collections/:name/position/*id', (req, res) => {
		const d = store.descriptor(req.params.name);
		const field = d.sort_field;
		if (!field) return res.status(400).json({ error: `collection "${d.name}" declares no sort_field` });
		const rows = [];
		for (const { id, fields } of store.readAll(d.name)) rows.push({ id, key: fields[field] ?? '' });
		sortRows(rows, 'key');
		const id = idParam(req);
		try {
			store.set(d.name, id, { [field]: placementKey(rows, id, req.body ?? {}, d.name) });
			res.json({ id });
		} catch (e) {
			res.status(400).json({ error: e.message });
		}
	});

	api.delete('/collections/:name/records/*id', (req, res) => {
		if (store.descriptors.get(req.params.name)?.storage?.base === 'runtime') {
			const out = systemWrite(ws, store, req);
			reload();
			return res.json(out);
		}
		store.rm(req.params.name, idParam(req), { force: req.query.force === 'true' });
		res.json({ id: idParam(req) });
	});

	api.post('/collections/:name/rename', (req, res) => {
		const { old: oldId, new: newId } = req.body ?? {};
		const out = store.rename(req.params.name, oldId, newId);
		res.json(out);
	});

	api.get('/history/:name/*id', (req, res) => {
		res.json(history(store, req.params.name, idParam(req)));
	});

	// presentation projection (adapter inversion, M3): how to RENDER each field/collection.
	api.get('/presentation', (req, res) => {
		res.json(presentation(store.descriptors));
	});

	// bound commands + per-record state for the Commands tab — ?ids=<id>[,<id>…]
	// (same op as `dreamteamer commands for`; the UI only renders what this returns)
	api.get('/commands/:name', (req, res) => {
		const ids = typeof req.query.ids === 'string' ? req.query.ids.split(',').map((s) => s.trim()).filter(Boolean) : [];
		res.json(commandsFor(store, req.params.name, ids));
	});

	// the vocabulary a field actually uses — what the filter panel offers as choices for a plain
	// `type: string` field no enum describes (same op as `dreamteamer <c> values <field>`).
	api.get('/collections/:name/values/:field', (req, res) => {
		const limit = req.query.limit === undefined ? undefined : Number(req.query.limit);
		res.json(distinctValues(store, req.params.name, req.params.field, { limit }));
	});

	// ---- schema writes (M3): source-writing ops behind the compile dry-run gate ------
	// every op writes the workspace descriptor source, proves it with a real compile
	// (CompileError → 400, source restored), commits, and reloads the Store.
	const schemaOp = (fn) => (req, res, next) => {
		try {
			const out = fn(req);
			reload();
			res.json(out);
		} catch (e) { next(e); }
	};
	// ---- fields: the ONE sub-entity (§3.2), so they keep dedicated routes rather than being
	// records of a `fields` collection nobody ships. Selector in the query string, as everywhere.
	api.post('/collections/:name/fields', schemaOp((req) => {
		const b = req.body ?? {};
		const prop = b.prop ?? fieldDef(store, b, req.params.name);
		return addField(ws, store, req.params.name, { name: b.name, prop, required: b.required === true, moduleId: moduleParam(req) });
	}));
	api.patch('/collections/:name/fields/:field', schemaOp((req) => {
		const b = req.body ?? {};
		const prop = b.prop ?? fieldDef(store, b, req.params.name);
		// updateField carries every relation keyword the caller did NOT restate, so it has to be told
		// what this one meant. A body carrying a whole `prop` (the studio's field drawer) has stated
		// the entire field — the default `stated` is "everything", so nothing is carried into it
		// behind its back. A body in the flag vocabulary states only the flags it named; without
		// this, `type` was never stated, `x-reference` was always carried, and a retype away from a
		// reference was a silent no-op that then failed the commit gate with a misleading rollback.
		const stated = b.prop ? undefined : statedKeywords(b);
		return updateField(ws, store, req.params.name, req.params.field, { prop, required: b.required, flags: b.prop ? {} : b, stated, moduleId: moduleParam(req) });
	}));
	// `…/name` rather than a body key, because renaming a field is a DIFFERENT act from editing one:
	// it rewrites the key in every record and in every descriptor, view and binding that names it.
	api.patch('/collections/:name/fields/:field/name', schemaOp((req) =>
		renameField(ws, store, req.params.name, req.params.field, String(req.body?.to ?? ''), { moduleId: moduleParam(req) })));
	api.delete('/collections/:name/fields/:field', schemaOp((req) =>
		removeField(ws, store, req.params.name, req.params.field, { moduleId: moduleParam(req) })));

	// per-record revision diff + revert (M3: git already has the data; this exposes it)
	api.get('/history-diff/:name/*id', (req, res) => {
		res.json(historyDiff(store, req.params.name, idParam(req), String(req.query.hash ?? 'HEAD')));
	});
	api.post('/collections/:name/records-revert/*id', (req, res) => {
		res.json(store.revert(req.params.name, idParam(req), String(req.body?.hash ?? '')));
	});


	api.post('/reload', (req, res) => { reload(); res.json({ ok: true }); });

	app.use('/api', api);

	// module UI bundles staged by compile (.dreamteamer/ui/<module>/app.js)
	app.use('/ui', express.static(path.join(ws.root, '.dreamteamer', 'ui')));

	// error contract: store errors are 400 (validation) / 404 (missing) / 409 (referenced)
	app.use((err, req, res, next) => {
		const msg = err.message ?? String(err);
		const code = err instanceof CompileError ? 400
			: /no such record/.test(msg) ? 404
			: /referenced by|already exists/.test(msg) ? 409 : 400;
		res.status(code).json({ error: msg });
	});

	// studio: explicit config (pkg.dreamteamer.studio, a path TO a dist dir) wins;
	// else the first discovered module (channel precedence order) shipping a built
	// studio — studio/dist for the inline engine, dist/ for a dedicated studio package.
	let studioDist = null;
	if (typeof ws.pkg.dreamteamer?.studio === 'string') {
		studioDist = path.join(ws.root, ws.pkg.dreamteamer.studio);
	} else {
		outer: for (const m of discoverModules(ws.root, ws.pkg).modules) {
			for (const cand of [path.join(m.root, 'studio', 'dist'), path.join(m.root, 'dist')]) {
				if (fs.existsSync(path.join(cand, 'index.html'))) { studioDist = cand; break outer; }
			}
		}
	}
	if (studioDist && fs.existsSync(path.join(studioDist, 'index.html'))) {
		app.use('/admin', express.static(studioDist));
		app.get('/admin/*rest', (req, res) => res.sendFile(path.join(studioDist, 'index.html')));
	} else {
		app.get('/admin', (req, res) => res.status(503).send('studio not built — run: npm run build:studio, or install @dreamteamer/studio'));
	}
	const hasStudio = !!(studioDist && fs.existsSync(path.join(studioDist, 'index.html')));
	app.get('/', (req, res) => res.redirect(hasStudio ? '/admin' : '/api'));

	return new Promise((resolve) => {
		const server = app.listen(port, host, () => {
			// Only advertise /admin when a studio is actually installed. No studio ships with the
			// engine, so naming it unconditionally sent every new user to a 503.
			const where = hasStudio ? `/admin (api: /api)` : `/api`;
			console.log(`✔ dreamteamer server at http://${host}:${port}${where}`);
			resolve(server);
		});
	});
}

/** The `?module=` SELECTOR, as one reader. §12: selector in the query string, field in the body —
 *  which is what keeps "edit the overlay" (`?module=default`) and "change the owner"
 *  (`{module: "hr"}`) two different requests rather than one ambiguous one. */
function moduleParam(req) {
	return req.query.module ? String(req.query.module) : undefined;
}

/**
 * The HTTP face of `collections-cli.js`'s system verbs — same functions, same validation, same
 * commit shape, which is the engine/UI parity rule (CLAUDE.md: a route with no CLI equivalent is a
 * gap).
 *
 *   POST   /collections/collections/records?module=hr   {name, description}          → create in hr
 *   PATCH  /collections/collections/records/people?module=default {description}      → edit overlay
 *   PATCH  /collections/collections/records/people      {module: "hr"}               → the MOVE
 *
 * ⚠ The in-process exports are UNTOUCHED. `ext:src/api.ts` and `ext:src/engine.ts` import
 * `createCollection`, `addField`, `updateField`, `removeField`, `saveUiView` and `removeUiView` by
 * name; renaming any of them is a cross-repo activation failure, so the new operations are new
 * exports beside them.
 */
function systemWrite(ws, store, req) {
	const kind = req.params.name;
	const id = req.params.id ? idParam(req) : undefined;
	const moduleId = moduleParam(req);
	const b = req.body ?? {};
	if (req.method === 'POST') {
		if (kind === 'collections') return createCollection(ws, store, { ...b, moduleId });
		if (kind === 'modules') return createModule(ws, store, b);
		if (kind === 'skills') return createSkill(ws, store, { ...b, moduleId });
		if (kind === 'ui-views') return saveUiView(ws, store, { id: b.id, view: b.view });
		return refuseHandAuthored(ws, store, kind, b.name, moduleId);
	}
	if (req.method === 'DELETE') {
		if (kind === 'collections') return removeCollection(ws, store, id, { force: req.query.force === 'true' });
		if (kind === 'modules') return removeModule(ws, store, id, { force: req.query.force === 'true' });
		if (kind === 'ui-views') return removeUiView(ws, store, id);
		return removeEntity(ws, store, kind, id);
	}
	// PATCH
	if (kind === 'collections') {
		if (typeof b.module === 'string') return moveCollection(ws, store, id, b.module);
		return setCollectionScalars(ws, store, id, b, { moduleId });
	}
	if (kind === 'modules') return setModule(ws, store, id, b);
	if (kind === 'ui-views') return saveUiView(ws, store, { id, view: b.view ?? b });
	return setEntityFrontmatter(ws, store, kind, id, b);
}

function idParam(req) {
	const id = req.params.id;
	return Array.isArray(id) ? id.join('/') : id;
}

// list-level "last modified" (operator ask 2026-07-27): ONE `git log` per collection listing —
// newest-first, so the first sighting of a path is its most recent touching commit — rather than
// one process spawn per record. `dir` outside the repo (or the repo having no history for it,
// e.g. a brand-new untracked file, or a runtime-based collection whose records live in the
// gitignored `.dreamteamer/` runtime) degrades to an empty map, i.e. every row gets `null`.
function gitModifiedMap(root, dir) {
	const map = new Map();
	const rel = path.relative(root, dir);
	if (rel.startsWith('..')) return map;
	let out;
	try {
		out = execFileSync('git', ['log', '--format=%x01%aI', '--name-only', '--', rel], { cwd: root }).toString();
	} catch { return map; }
	let date = null;
	for (const line of out.split('\n')) {
		if (line.startsWith('\x01')) { date = line.slice(1); continue; }
		if (!line) continue;
		if (!map.has(line)) map.set(line, date);
	}
	return map;
}

// single-record commit info (detail page header, operator ask 2026-07-27: author + message
// alongside the date, GitHub-file-header style) — one cheap `git log -1` on just that file.
// Author name only (%an) — no Co-Authored-By trailer parsing, by design (scope call, not a gap).
function gitLastCommit(root, file) {
	const rel = path.relative(root, file);
	if (rel.startsWith('..')) return null;
	try {
		const out = execFileSync('git', ['log', '-1', '--format=%aI%x00%an%x00%s', '--', rel], { cwd: root }).toString().trim();
		if (!out) return null;
		const [date, author, message] = out.split('\0');
		return { date, author, message };
	} catch { return null; }
}
