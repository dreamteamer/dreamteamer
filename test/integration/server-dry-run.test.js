// Tier 2 — `?dry-run=true` over HTTP, against a real server on a real workspace.
//
// ⚠ THIS FILE EXISTS BECAUSE ASKING WHAT A VERB WOULD DO PERFORMED IT. `systemWrite` parsed the
// query string for `force` and for nothing else, so a client requesting a plan for a destructive
// schema verb got the write — a module removed, a collection moved between modules, a field renamed
// across every record and descriptor naming it. The CLI has taken `--dry-run` on those verbs since
// the plan/apply split, which is precisely what made the omission dangerous: both surfaces are
// documented as the same operation, so a client has every reason to believe the flag is honoured.
//
// Every assertion below checks the SAME TWO THINGS — the response, and that the disk did not move.
// The second is the one that matters: a plan that is indistinguishable from a write, except that it
// also wrote, is the failure this guards.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, simpleCollection, WS_MODULE } from '../helpers/ws.js';
import { startServer } from '../../src/server.js';

const PORT = 8137;
const api = `http://127.0.0.1:${PORT}/api`;

let server;
let ws;

const call = async (method, url, { body, ...rest } = {}) => {
	const res = await fetch(url, {
		method,
		headers: body ? { 'content-type': 'application/json' } : undefined,
		body: body ? JSON.stringify(body) : undefined,
		...rest,
	});
	let json = null;
	try { json = await res.json(); } catch { /* empty body */ }
	return { status: res.status, json };
};

/** Every tracked source path under modules/, with its bytes — the disk, as a comparable value. */
const snapshot = (root) => {
	const out = new Map();
	const walk = (d) => {
		if (!fs.existsSync(d)) return;
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p);
			else out.set(path.relative(root, p), fs.readFileSync(p, 'utf8'));
		}
	};
	walk(path.join(root, 'modules'));
	return out;
};

const assertUntouched = (before, root, what) => {
	const after = snapshot(root);
	assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), `${what}: the set of source files moved`);
	for (const [f, bytes] of before) assert.equal(after.get(f), bytes, `${what}: ${f} was rewritten`);
};

before(async () => {
	const log = console.log;
	console.log = () => {};
	try {
		ws = workspace({
			collections: {
				widgets: simpleCollection({ storage: { suffix: 'widget' } }),
				gadgets: simpleCollection({ storage: { suffix: 'gadget' } }),
			},
		});
		ws.dt('add', 'modules', '--name', 'spare', '--description', 'A second module, so a move has somewhere to go.');
		server = await startServer(ws.ws, { port: PORT });
	} finally {
		console.log = log;
	}
});

after(() => server?.close());

describe('dry-run over HTTP', () => {
	test('removing a module returns a PLAN and removes nothing', async () => {
		const before = snapshot(ws.root);
		const { status, json } = await call('DELETE', `${api}/collections/modules/records/spare?force=true&dry-run=true`);
		assert.equal(status, 200);
		assert.equal(json.dryRun, true, 'the response says it was a plan');
		assert.ok(fs.existsSync(path.join(ws.root, 'modules', 'spare')), 'the module is still on disk');
		assertUntouched(before, ws.root, 'modules:rm');
	});

	test('moving a collection between modules returns a PLAN and moves nothing', async () => {
		const before = snapshot(ws.root);
		const { status, json } = await call('PATCH', `${api}/collections/collections/records/widgets?dry-run=true`, {
			body: { module: 'spare' },
		});
		assert.equal(status, 200);
		assert.equal(json.dryRun, true);
		assert.ok(fs.existsSync(path.join(ws.root, 'modules', WS_MODULE, 'collections', 'widgets.collection.yaml')),
			'the descriptor is still in the module it started in');
		assertUntouched(before, ws.root, 'collections:move');
	});

	test('renaming a field returns a PLAN and renames nothing', async () => {
		const before = snapshot(ws.root);
		const { status, json } = await call('PATCH', `${api}/collections/widgets/fields/name/name?dry-run=true`, {
			body: { to: 'title' },
		});
		assert.equal(status, 200);
		assert.equal(json.dryRun, true);
		assertUntouched(before, ws.root, 'fields:rename');
	});

	// ── the refusals ──────────────────────────────────────────────────────────────────────────
	// An op that cannot describe what it would do must REFUSE, never guess and never proceed. A 200
	// with an empty plan would read as "this would change nothing", which is the opposite of true.
	test('an op with no plan is REFUSED with 400, and still writes nothing', async () => {
		const before = snapshot(ws.root);
		const { status, json } = await call('POST', `${api}/collections/collections/records?dry-run=true`, {
			body: { name: 'sprockets', description: 'Should never exist.' },
		});
		assert.equal(status, 400, 'refused, not performed');
		assert.equal(json['dry-run'], 'unsupported');
		assert.match(json.error, /dry-run is not supported/);
		assert.match(json.error, /Nothing was written/);
		assert.ok(!fs.existsSync(path.join(ws.root, 'modules', WS_MODULE, 'collections', 'sprockets.collection.yaml')),
			'THE WHOLE POINT: asking what it would do did not do it');
		assertUntouched(before, ws.root, 'collections:add');
	});

	test('removing a field is refused under dry-run rather than clearing every record', async () => {
		const before = snapshot(ws.root);
		const { status, json } = await call('DELETE', `${api}/collections/gadgets/fields/name?dry-run=true`);
		assert.equal(status, 400);
		assert.equal(json['dry-run'], 'unsupported');
		assertUntouched(before, ws.root, 'fields:rm');
	});

	test('the refusal names what IS supported, so a client can act on it', async () => {
		const { json } = await call('POST', `${api}/collections/skills/records?dry-run=true`, {
			body: { name: 'nope', description: 'x' },
		});
		for (const verb of ['modules:rm', 'collections:move', 'fields:rename']) {
			assert.ok(json.error.includes(verb), `the refusal names ${verb}`);
		}
	});

	// ── and the ordinary path is untouched ────────────────────────────────────────────────────
	test('without the flag the write still happens — the guard did not break the verb', async () => {
		const { status } = await call('POST', `${api}/collections/collections/records`, {
			body: { name: 'sprockets', description: 'Created for real.' },
		});
		assert.equal(status, 200);
		assert.ok(fs.existsSync(path.join(ws.root, 'modules', WS_MODULE, 'collections', 'sprockets.collection.yaml')));
	});

	test('a falsy dry-run value is not a dry run', async () => {
		// `?dry-run=false` and a bare `?dry-run` must not silently turn a write into a plan — that
		// would be the same bug pointing the other way, and far harder to notice.
		const { status } = await call('DELETE', `${api}/collections/collections/records/sprockets?force=true&dry-run=false`);
		assert.equal(status, 200);
		assert.ok(!fs.existsSync(path.join(ws.root, 'modules', WS_MODULE, 'collections', 'sprockets.collection.yaml')),
			'dry-run=false performed the removal');
	});
});
