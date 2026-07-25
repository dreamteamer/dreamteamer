// dreamteamer server — the CLEAN REST contract over the same validating store the
// CLI uses (decision #16: nothing Directus-flavored lives here; the studio's api
// client carries the one transitional adapter). serves the built studio at /admin.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import express from 'express';
import { Store, bodyField } from './store.js';
import { readManifest, staleness, discoverModules } from './compile.js';
import { matchesFilter } from './filter.js';
import { slugOrHash } from './template.js';

export function startServer(ws, { port = 8080, host = '127.0.0.1' } = {}) {
	const app = express();
	app.use(express.json({ limit: '10mb' }));

	// a fresh Store per mutating request would be wasteful; per-process with manual
	// reload on demand is enough for a local single-operator server (RAD).
	let store = new Store(ws);
	const reload = () => { store = new Store(ws); };

	const api = express.Router();

	// current operator id — same rule init seeds users with (slugOrHash of git user.name),
	// so `@me` filters in ui-views resolve to the seeded user record.
	let operatorId = null;
	try {
		operatorId = slugOrHash(execFileSync('git', ['config', 'user.name'], { cwd: ws.root }).toString().trim());
	} catch { /* no git identity — @me filters simply won't narrow */ }

	api.get('/info', (req, res) => {
		const manifest = readManifest(ws.root);
		const stale = staleness(ws.root);
		res.json({
			name: ws.pkg.name,
			host: manifest?.host,
			compiled: manifest?.compiled,
			modules: manifest?.modules ?? [],
			ui: manifest?.ui ?? [], // module UI bundles staged at /ui/<name>/app.js
			user: operatorId,
			stale: stale.stale?.length ?? 0,
			collections: [...store.descriptors.keys()],
		});
	});

	api.get('/schema', (req, res) => {
		res.json([...store.descriptors.values()].sort((a, b) => (a.order ?? 999) - (b.order ?? 999)));
	});

	api.get('/collections/:name/records', (req, res) => {
		const d = store.descriptor(req.params.name);
		const bf = bodyField(d);
		const { limit = 200, offset = 0, sort, q, filter, ...rest } = req.query;
		let rows = [];
		for (const [id] of store.ids(req.params.name)) {
			const { fields } = store.read(req.params.name, id);
			rows.push({ ...fields, id }); // record id WINS over any schema field named "id"
		}
		// rich filter: ?filter=<json> — Directus-style operators (_eq/_contains/_and/...)
		if (filter) {
			const f = typeof filter === 'string' ? JSON.parse(filter) : filter;
			rows = rows.filter((r) => matchesFilter(r, f));
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
		if (sort) {
			const desc = String(sort).startsWith('-');
			const key = desc ? String(sort).slice(1) : String(sort);
			rows.sort((a, b) => String(a[key] ?? '').localeCompare(String(b[key] ?? '')) * (desc ? -1 : 1));
		}
		const total = rows.length;
		rows = rows.slice(Number(offset), Number(offset) + Number(limit));
		const wantBody = req.query['with-body'] === 'true';
		if (bf && !wantBody) for (const r of rows) delete r[bf];
		res.json({ records: rows, total });
	});

	api.get('/collections/:name/records/*id', (req, res) => {
		const { fields, file } = store.read(req.params.name, idParam(req));
		res.json({ id: idParam(req), fields, path: path.relative(ws.root, file) });
	});

	api.post('/collections/:name/records', (req, res) => {
		const { id: explicitId, ...fields } = req.body ?? {};
		const { id, file } = store.add(req.params.name, fields, { id: explicitId });
		res.status(201).json({ id, path: path.relative(ws.root, file) });
	});

	api.patch('/collections/:name/records/*id', (req, res) => {
		const { id: _id, path: _path, ...changes } = req.body ?? {}; // clients may echo the row's id/path — never persist them
		store.set(req.params.name, idParam(req), changes);
		res.json({ id: idParam(req) });
	});

	api.delete('/collections/:name/records/*id', (req, res) => {
		store.rm(req.params.name, idParam(req), { force: req.query.force === 'true' });
		res.json({ id: idParam(req) });
	});

	api.post('/collections/:name/rename', (req, res) => {
		const { old: oldId, new: newId } = req.body ?? {};
		const out = store.rename(req.params.name, oldId, newId);
		res.json(out);
	});

	api.get('/history/:name/*id', (req, res) => {
		const { file } = store.read(req.params.name, idParam(req));
		const log = execFileSync('git', ['log', '--follow', '--format=%H%x00%an%x00%aI%x00%s', '--', path.relative(ws.root, file)], { cwd: ws.root })
			.toString().trim().split('\n').filter(Boolean)
			.map((l) => { const [hash, author, date, subject] = l.split('\0'); return { hash, author, date, subject }; });
		res.json(log);
	});

	api.post('/reload', (req, res) => { reload(); res.json({ ok: true }); });

	app.use('/api', api);

	// module UI bundles staged by compile (.dreamteamer/ui/<module>/app.js)
	app.use('/ui', express.static(path.join(ws.root, '.dreamteamer', 'ui')));

	// error contract: store errors are 400 (validation) / 404 (missing) / 409 (referenced)
	app.use((err, req, res, next) => {
		const msg = err.message ?? String(err);
		const code = /no such record/.test(msg) ? 404 : /referenced by|already exists/.test(msg) ? 409 : 400;
		res.status(code).json({ error: msg });
	});

	// studio: explicit config (pkg.dreamteamer.studio, a path TO a dist dir) wins;
	// else the first discovered module (channel precedence order) shipping a built
	// studio — studio/dist for the inline engine, dist/ for a dedicated studio package.
	let studioDist = null;
	if (ws.pkg.dreamteamer?.studio) {
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
	app.get('/', (req, res) => res.redirect('/admin'));

	return new Promise((resolve) => {
		const server = app.listen(port, host, () => {
			console.log(`✔ dreamteamer server at http://${host}:${port}/admin (api: /api)`);
			resolve(server);
		});
	});
}

function idParam(req) {
	const id = req.params.id;
	return Array.isArray(id) ? id.join('/') : id;
}
