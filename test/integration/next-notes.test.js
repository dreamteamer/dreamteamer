// Tier 2 — the `next` contribution: what an extension says about a record in `dt next`.
//
// `dt next <ref>` answers "what can I do with this record, and in which state". An extension that
// knows something else about the record's state — a session holding it, say — contributes
// `next: ({ root, ws, collection, ids }) → [{ id, text }]`, and the engine prints each line under the
// bound commands and returns it as `notes` in `--json`. A synthetic extension, never a real one: core
// must not learn a tool's name to work.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, simpleCollection, dt, compileQuietly, WS_MODULE } from '../helpers/ws.js';
import { Store } from '../../src/store.ts';
import { openWorkspace, contributedNotes } from '../../src/api.ts';

/** A workspace module carrying an extension whose `next` is `body` (a function expression's text). */
function withNoter(body) {
	const ws = workspace({ compile: false, collections: { notes: simpleCollection() } });
	const dir = path.join(ws.root, 'modules', 'noter');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'noter', version: '0.1.0', type: 'module', dreamteamer: { extension: './ext.js' } }));
	fs.writeFileSync(path.join(dir, 'ext.js'), `export const apiVersion = 1;\nexport default function activate() { return { next: ${body} }; }\n`);
	compileQuietly(ws.ws);
	new Store(ws.ws).add('notes', { name: 'One' });
	new Store(ws.ws).add('notes', { name: 'Two' });
	return ws;
}

const SAYS = `({ collection, ids }) => ids.filter((id) => id === 'one').map((id) => ({ id, text: 'held by Dana Oren since 09:00 (' + collection + ')' }))`;

describe('an extension says a line about a record in dt next', () => {
	test('dt next <ref> prints the line under the bound commands; --json returns it as notes, attributed', () => {
		const ws = withNoter(SAYS);
		const res = dt(ws.root, 'next', 'notes/one');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /no commands bound to notes/);
		assert.match(res.stdout, /notes\/one — held by Dana Oren since 09:00 \(notes\) \(noter\)/);
		const json = JSON.parse(dt(ws.root, 'next', 'notes/one', '--json').stdout);
		assert.deepEqual(json.notes, [{ id: 'one', text: 'held by Dana Oren since 09:00 (notes)', by: 'noter' }]);
	});

	test('a record the extension says nothing about prints no line, and --json carries an empty notes', () => {
		const ws = withNoter(SAYS);
		const res = dt(ws.root, 'next', 'notes/two');
		assert.equal(res.code, 0, res.stderr);
		assert.doesNotMatch(res.stdout, /held by/);
		assert.deepEqual(JSON.parse(dt(ws.root, 'next', 'notes/two', '--json').stdout).notes, []);
	});

	test('a next that throws is a failure note naming the extension, and dt next still exits 0', () => {
		const ws = withNoter(`() => { throw new Error('no folder'); }`);
		const res = dt(ws.root, 'next', 'notes/one');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /✖ noter: next failed — no folder/);
	});

	test('a next that is not a function is refused at load, naming the extension', () => {
		const ws = withNoter(`'held'`);
		const res = dt(ws.root, 'next', 'notes/one');
		assert.notEqual(res.code, 0);
		assert.match(res.stderr, /extension noter: next must be a function/);
	});

	test('contributedNotes is the one implementation: the public API returns what dt next prints', async () => {
		const ws = withNoter(SAYS);
		const opened = await openWorkspace(ws.root);
		assert.deepEqual(contributedNotes(opened, 'notes', ['one', 'two']), [{ id: 'one', text: 'held by Dana Oren since 09:00 (notes)', by: 'noter' }]);
		assert.deepEqual(contributedNotes(opened, 'notes', []), []);
	});
});
