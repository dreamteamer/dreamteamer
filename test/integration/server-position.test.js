// Tier 2 — the manual-ordering HTTP route, against a real server on a real workspace.
//
// ⚠ THIS FILE EXISTS BECAUSE OF A ROUTING COLLISION THAT PASSED EVERY OTHER GATE. The first version
// of the route was `PATCH /collections/:name/records/:id/position`, which every unit and CLI test
// was happy with — but `…/records/*id` is greedy (ids are PATHS), so the ordinary record PATCH
// matched first and answered `404 ordered/charlie/position: no such record`. Only a request to a
// running server showed it. The verb now comes BEFORE the wildcard, and this locks that in.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { workspace } from '../helpers/ws.js';
import { startServer } from '../../src/server.js';

const PORT = 8121;
const base = `http://127.0.0.1:${PORT}/api/collections/ordered`;

const ORDERED = {
	sort_field: 'position',
	id: { generate: '{{ name | slug }}' },
	storage: { suffix: 'task' },
	schema: {
		type: 'object',
		required: ['name'],
		properties: { name: { type: 'string' }, position: { type: 'string', pattern: '^[a-z]+$' } },
	},
};

let server;
let ws;

before(async () => {
	const log = console.log;
	console.log = () => {};
	try {
		ws = workspace({
			collections: { ordered: ORDERED },
			records: { ordered: [{ name: 'Alpha' }, { name: 'Bravo' }, { name: 'Charlie' }] },
		});
		ws.dt('ordered', 'move', '--init');
		server = await startServer(ws.ws, { port: PORT });
	} finally {
		console.log = log;
	}
});

after(() => server?.close());

const ids = async () => {
	const body = await (await fetch(`${base}/records?sort=position`)).json();
	return (Array.isArray(body) ? body : body.records ?? body.data).map((r) => r.id);
};
const move = async (id, dest) => {
	const res = await fetch(`${base}/position/${id}`, {
		method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(dest),
	});
	return { status: res.status, body: await res.json() };
};

describe('PATCH /collections/:name/position/*id', () => {
	test('the route is reachable at all — the greedy-wildcard regression', async () => {
		const r = await move('charlie', { top: true });
		assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
		assert.deepEqual(r.body, { id: 'charlie' });
	});

	test('top puts it first', async () => {
		await move('charlie', { top: true });
		assert.deepEqual(await ids(), ['charlie', 'alpha', 'bravo']);
	});

	test('before/after place it relative to a neighbour', async () => {
		await move('charlie', { before: 'bravo' });
		assert.deepEqual(await ids(), ['alpha', 'charlie', 'bravo']);
		await move('alpha', { after: 'charlie' });
		assert.deepEqual(await ids(), ['charlie', 'alpha', 'bravo']);
	});

	test('bottom puts it last', async () => {
		await move('charlie', { bottom: true });
		assert.equal((await ids()).at(-1), 'charlie');
	});

	test('an unknown destination is a 400 and changes nothing', async () => {
		const was = await ids();
		const r = await move('charlie', { after: 'nosuch' });
		assert.equal(r.status, 400);
		assert.match(r.body.error, /move --init/);
		assert.deepEqual(await ids(), was);
	});
});
