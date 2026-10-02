// Tier 2 — `storage.under.id: nested`: the id begins with the parent's id, the file drops that
// segment, uniqueness is per parent, and changing the parent is a rename. Invented names only.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, writeCollection, compileError, compileQuietly, dt } from '../helpers/ws.js';

const PEOPLE = { description: 'A person.', storage: { shape: 'folder', entry: 'person.md' }, ids: { from: '{{ name | slug }}' }, fields: { name: { type: 'string', required: true }, notes: { type: 'markdown', body: true } } };
const RESULTS = (id = 'nested', from = '{{ person | basename }}/{{ date }}--{{ analyte }}') => ({
	description: 'One lab value.',
	storage: { under: { parent: 'person', subfolder: 'lab-results', id } },
	ids: { from },
	fields: { person: { type: 'people', required: true }, date: { type: 'date', required: true }, analyte: { type: 'string', required: true }, notes: { type: 'markdown', body: true } },
});
function ws(results = RESULTS()) {
	const w = workspace({ compile: false });
	writeCollection(w.root, 'people', PEOPLE);
	writeCollection(w.root, 'lab-results', results);
	return w;
}
const ready = () => {
	const w = ws();
	compileQuietly(w.ws);
	dt(w.root, 'add', 'people', '--name', 'Ada');
	dt(w.root, 'add', 'people', '--name', 'Lin');
	return w;
};
const add = (w, who) => dt(w.root, 'add', 'lab-results', '--person', `people/${who}`, '--date', '2026-01-02', '--analyte', 'alt');

describe('nested ids', () => {
	test('the id leads with the parent; the file drops that segment; two people\'s same-day value do not collide', () => {
		const w = ready();
		assert.equal(add(w, 'ada').code, 0);
		assert.equal(add(w, 'lin').code, 0, 'per-parent uniqueness: same local id under another parent');
		assert.ok(fs.existsSync(path.join(w.root, 'data', 'people', 'ada', 'lab-results', '2026-01-02--alt.lab-result.md')));
		assert.equal(JSON.parse(dt(w.root, 'get', 'lab-results/ada/2026-01-02--alt', '--json').stdout).analyte, 'alt');
		assert.equal(dt(w.root, 'check').code, 0);
	});
	test('set of the parent is refused, naming rename; rename moves it and rewrites the owner', () => {
		const w = ready();
		add(w, 'ada');
		const set = dt(w.root, 'set', 'lab-results/ada/2026-01-02--alt', 'person=people/lin');
		assert.notEqual(set.code, 0);
		assert.match(set.stderr, /changes the id — rename it instead: dreamteamer rename lab-results\/ada\/2026-01-02--alt <new parent id>\/2026-01-02--alt/);
		const ren = dt(w.root, 'rename', 'lab-results/ada/2026-01-02--alt', 'lin/2026-01-02--alt');
		assert.equal(ren.code, 0, ren.stderr);
		assert.ok(fs.existsSync(path.join(w.root, 'data', 'people', 'lin', 'lab-results', '2026-01-02--alt.lab-result.md')));
		assert.equal(JSON.parse(dt(w.root, 'get', 'lab-results/lin/2026-01-02--alt', '--json').stdout).person, 'people/lin');
		assert.equal(dt(w.root, 'check').code, 0);
	});
	test('check reports a parent field that disagrees with the id', () => {
		const w = ready();
		add(w, 'ada');
		const f = path.join(w.root, 'data', 'people', 'ada', 'lab-results', '2026-01-02--alt.lab-result.md');
		fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('person: people/ada', 'person: people/lin'));
		const c = dt(w.root, 'check');
		assert.notEqual(c.code, 0);
		assert.match(c.stdout + c.stderr, /a nested id begins with its parent's/);
	});
	test('compile requires every ids.from to open with the parent', () => {
		assert.match(compileError(ws(RESULTS('nested', '{{ date }}--{{ analyte }}')).ws), /every ids\.from template must open with `\{\{ person \| basename \}\}\/`/);
		assert.match(compileError(ws(RESULTS('sideways')).ws), /storage\.under\.id` is independent/);
	});
	test('independent (the default) is unchanged: the id survives a move and is unique across parents', () => {
		const w = ws(RESULTS('independent', '{{ date }}--{{ analyte }}'));
		compileQuietly(w.ws);
		dt(w.root, 'add', 'people', '--name', 'Ada');
		dt(w.root, 'add', 'people', '--name', 'Lin');
		assert.equal(add(w, 'ada').code, 0);
		assert.notEqual(add(w, 'lin').code, 0, 'the same id under another parent collides');
		assert.equal(dt(w.root, 'set', 'lab-results/2026-01-02--alt', 'person=people/lin').code, 0, 'a set moves it, id unchanged');
	});
});
