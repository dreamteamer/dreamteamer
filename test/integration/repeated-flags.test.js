// Tier 2 — what a REPEATED argument means, through the real binary in a real workspace.
//
// Every case here exited 0 with the wrong answer before the parser started promoting a repeat to an
// array. `--tags a --tags b` wrote `[b]` and lost the first value; `--filter a=1 --filter b=2`
// silently dropped the first condition and printed rows the caller had excluded. A narrowing verb
// that answers a question nobody asked is the worst thing this CLI can do, so the assertions below
// name the row that must NOT come back, not just the one that must.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { workspace } from '../helpers/ws.js';

const NOTES = {
	id: { generate: '{{ title | slug }}' },
	storage: { suffix: 'note' },
	schema: {
		type: 'object',
		required: ['title'],
		properties: {
			title: { type: 'string' },
			status: { type: 'string' },
			owner: { type: 'string' },
			tags: { type: 'array', items: { type: 'string' } },
			body: { type: 'string', format: 'markdown', 'x-body': true },
		},
	},
};

const base = () => workspace({ collections: { notes: NOTES } });
const fields = (ws, id) => JSON.parse(ws.dt('get', `notes/${id}`, '--json').stdout);
const ids = (res) => JSON.parse(res.stdout).map((r) => r.id);

describe('a repeated --<field> on an ARRAY field is one element per sighting', () => {
	test('both values land, in the order typed', () => {
		const ws = base();
		const res = ws.dt('add', 'notes', '--title', 'One', '--tags', 'a', '--tags', 'b');
		assert.equal(res.code, 0, res.stderr);
		assert.deepEqual(fields(ws, 'one').tags, ['a', 'b']);
	});

	test('a SINGLE value still splits on commas — the old spelling is untouched', () => {
		const ws = base();
		assert.equal(ws.dt('add', 'notes', '--title', 'One', '--tags', 'a,b').code, 0);
		assert.deepEqual(fields(ws, 'one').tags, ['a', 'b']);
	});

	test('a repeated value is NOT split again, so a comma can live inside one element', () => {
		const ws = base();
		assert.equal(ws.dt('add', 'notes', '--title', 'One', '--tags', 'Ana, Bo', '--tags', 'c').code, 0);
		assert.deepEqual(fields(ws, 'one').tags, ['Ana, Bo', 'c']);
	});

	test('`dt set` takes the repeat too, in its positional pair form', () => {
		const ws = base();
		ws.dt('add', 'notes', '--title', 'One');
		const res = ws.dt('set', 'notes/one', 'tags=a', 'tags=b');
		assert.equal(res.code, 0, res.stderr);
		assert.deepEqual(fields(ws, 'one').tags, ['a', 'b']);
	});

	test('and in its flag form', () => {
		const ws = base();
		ws.dt('add', 'notes', '--title', 'One');
		assert.equal(ws.dt('set', 'notes/one', '--tags', 'a', '--tags', 'b').code, 0);
		assert.deepEqual(fields(ws, 'one').tags, ['a', 'b']);
	});
});

describe('a repeated field that is NOT an array is refused', () => {
	test('add names the field, the count and both spellings — it does not pick one', () => {
		const ws = base();
		const res = ws.dt('add', 'notes', '--title', 'One', '--status', 'todo', '--status', 'done');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /status was given 2 times/);
		assert.match(res.stderr, /--status <value> \/ status=<value>/);
		assert.match(res.stderr, /not an array field/);
		// and NOTHING was written — a refusal that half-wrote is worse than none
		assert.equal(ws.dt('get', 'notes/one', '--json').code, 1);
	});

	test('the positional pair form is refused identically', () => {
		const ws = base();
		ws.dt('add', 'notes', '--title', 'One');
		const res = ws.dt('set', 'notes/one', 'status=todo', 'status=done');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /status was given 2 times/);
		assert.equal(fields(ws, 'one').status, undefined, 'neither value landed');
	});
});

describe('--filter conditions COMPOSE (AND), they do not replace', () => {
	const seeded = () => {
		const ws = base();
		ws.dt('add', 'notes', '--title', 'One', '--status', 'todo', '--owner', 'ana');
		ws.dt('add', 'notes', '--title', 'Two', '--status', 'todo', '--owner', 'bo');
		ws.dt('add', 'notes', '--title', 'Three', '--status', 'done', '--owner', 'ana');
		return ws;
	};

	test('two --filter flags want BOTH', () => {
		const ws = seeded();
		const res = ws.dt('list', 'notes', '--filter', 'status=todo', '--filter', 'owner=ana', '--json');
		assert.equal(res.code, 0, res.stderr);
		// `three` is the row the last-wins parse used to return: owner=ana, status=done
		assert.deepEqual(ids(res), ['one']);
	});

	test('three of them, and a contradiction narrows to nothing rather than to the last one', () => {
		const ws = seeded();
		const res = ws.dt('list', 'notes', '--filter', 'status=todo', '--filter', 'status=done', '--json');
		assert.equal(res.code, 0, res.stderr);
		assert.deepEqual(ids(res), []);
	});

	test('one --filter is unchanged', () => {
		const ws = seeded();
		assert.deepEqual(ids(ws.dt('list', 'notes', '--filter', 'owner=ana', '--json')).sort(), ['one', 'three']);
	});

	test('a bare-field flag composes with a --filter, and with itself', () => {
		const ws = seeded();
		assert.deepEqual(ids(ws.dt('list', 'notes', '--owner', 'ana', '--filter', 'status=todo', '--json')), ['one']);
		assert.deepEqual(ids(ws.dt('list', 'notes', '--owner', 'ana', '--owner', 'bo', '--json')), []);
	});

	test('a --filter with no `=` is a mistake, not a condition that matches nothing', () => {
		const ws = seeded();
		const res = ws.dt('list', 'notes', '--filter', 'status', '--json');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /--filter takes <field>=<value>/);
	});
});

describe('a flag that holds ONE value says so when it is repeated', () => {
	test('--sort names the line that was typed instead of silently not sorting', () => {
		const ws = base();
		const res = ws.dt('list', 'notes', '--sort', 'title', '--sort', '-title', '--json');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /--sort was given 2 times and takes ONE value: --sort title --sort -title/);
	});

	test('--where too', () => {
		const ws = base();
		const res = ws.dt('list', 'notes', '--where', '{"status":{"_eq":"todo"}}', '--where', '{}', '--json');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /--where was given 2 times/);
	});

	test("but a caller's own --ids on a record target is still honoured, not counted as a repeat", () => {
		// `dt commands <c>/<id>` injects `--ids <id>`; it used to rely on last-wins to let an
		// explicit --ids override it, which promote-on-repeat would have turned into a refusal.
		const ws = base();
		ws.dt('add', 'notes', '--title', 'One');
		const res = ws.dt('commands', 'notes/one', '--ids', 'one');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /no commands bound to notes/);
	});
});
