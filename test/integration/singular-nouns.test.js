// Every record verb accepts the collection's SINGULAR, and one bare positional on `add` is the title
// — so `dt add task "call the bank"` is a sentence and the same write as `dt add tasks --name …`.
// What is pinned: the two spellings write byte-identical records; the singular reaches every verb
// family (record, ref, either, field, commit); a namespaced singular keeps its prefix; an authored
// `singular:` wins over inflection; compile refuses a collision naming both collections; and a
// reference VALUE inside a record never learns the singular — `check` still reports `task/x`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { twoModuleWorkspace, readFile } from '../helpers/ws.js';

const SINGULAR_LINE = /^singular: (.+)$/m;
const compiled = (ws, name) => readFile(ws.root, `.dreamteamer/collections/${name}.collection.yaml`);

describe('the singular is derived onto every compiled descriptor', () => {
	test('tasks → task, hr/positions → hr/position; the namespace stays', () => {
		const ws = twoModuleWorkspace();
		assert.equal(compiled(ws, 'tasks').match(SINGULAR_LINE)[1], 'task');
		assert.equal(compiled(ws, 'hr/positions').match(SINGULAR_LINE)[1], 'hr/position');
	});

	test('an authored singular wins over inflection (people → person)', () => {
		const ws = twoModuleWorkspace();
		const file = path.join(ws.root, 'modules', 'core', 'collections', 'people.collection.yaml');
		fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^name: people$/m, 'name: people\nsingular: person'));
		assert.equal(ws.dt('compile').code, 0);
		assert.equal(compiled(ws, 'people').match(SINGULAR_LINE)[1], 'person');
		const r = ws.dt('add', 'person', 'Ada Lovelace', '--employer', 'Analytical Engines');
		assert.equal(r.code, 0, r.stderr);
		assert.match(readFile(ws.root, 'data/people/ada-lovelace.person.md'), /name: Ada Lovelace/);
	});

	test('two collections answering to one word is a compile error that names both', () => {
		const ws = twoModuleWorkspace();
		// `team` is the singular compile derives for `teams`; authoring it on `tasks` collides.
		const file = path.join(ws.root, 'modules', 'core', 'collections', 'tasks.collection.yaml');
		fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^name: tasks$/m, 'name: tasks\nsingular: team'));
		const r = ws.dt('compile');
		assert.equal(r.code, 1);
		assert.match(r.stderr + r.stdout, /collections "(tasks|teams)" and "(teams|tasks)" both answer to the word "team"/);
	});

	test('a singular that equals another collection\'s NAME is refused the same way', () => {
		const ws = twoModuleWorkspace();
		const file = path.join(ws.root, 'modules', 'core', 'collections', 'tasks.collection.yaml');
		fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^name: tasks$/m, 'name: tasks\nsingular: people'));
		const r = ws.dt('compile');
		assert.equal(r.code, 1);
		assert.match(r.stderr + r.stdout, /collections "(tasks|people)" and "(people|tasks)" both answer to the word "people"/);
	});
});

describe('the singular reaches every verb family', () => {
	test('add task "<title>" and add tasks --name "<title>" write byte-identical records', () => {
		const ws = twoModuleWorkspace();
		const a = ws.dt('add', 'task', 'call the bank', '--notes', 'before Friday');
		assert.equal(a.code, 0, a.stderr);
		const first = readFile(ws.root, 'data/tasks/call-the-bank.task.md');
		assert.equal(ws.dt('rm', 'task/call-the-bank', '--force').code, 0);
		const b = ws.dt('add', 'tasks', '--name', 'call the bank', '--notes', 'before Friday');
		assert.equal(b.code, 0, b.stderr);
		assert.equal(readFile(ws.root, 'data/tasks/call-the-bank.task.md'), first);
	});

	test('list · get · set · history · values · next · add-field · commit all take the singular', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('add', 'task', 'file the return').code, 0);
		const list = ws.dt('list', 'task', '--json');
		assert.equal(list.code, 0, list.stderr);
		assert.equal(JSON.parse(list.stdout).length, 1);
		const get = ws.dt('get', 'task/file-the-return', '--json');
		assert.equal(get.code, 0, get.stderr);
		assert.equal(JSON.parse(get.stdout).name, 'file the return');
		const set = ws.dt('set', 'task/file-the-return', 'owner=people/nobody-yet');
		assert.equal(set.code, 1, 'a dangling reference was accepted');
		assert.equal(ws.dt('add', 'people', 'Grace Hopper').code, 0);
		const set2 = ws.dt('set', 'task/file-the-return', 'owner=people/grace-hopper');
		assert.equal(set2.code, 0, set2.stderr);
		assert.match(readFile(ws.root, 'data/tasks/file-the-return.task.md'), /owner: people\/grace-hopper/);
		const hist = ws.dt('history', 'task/file-the-return');
		assert.equal(hist.code, 0, hist.stderr);
		const values = ws.dt('values', 'task', 'owner');
		assert.equal(values.code, 0, values.stderr);
		assert.match(values.stdout, /grace-hopper/);
		assert.equal(ws.dt('next', 'task').code, 0);
		const field = ws.dt('add-field', 'task', '--name', 'due', '--type', 'string', '--description', 'When it is owed.');
		assert.equal(field.code, 0, field.stderr);
		assert.match(readFile(ws.root, 'modules/core/collections/tasks.collection.yaml'), /due:/);
		const commit = ws.dt('commit', 'task/file-the-return', '--dry-run');
		assert.equal(commit.code, 0, commit.stderr);
		assert.match(commit.stdout, /tasks\/file-the-return/);
	});

	test('a namespaced singular works as a target: add hr/position, get hr/position/<id>', () => {
		const ws = twoModuleWorkspace();
		const r = ws.dt('add', 'hr/position', 'Analyst');
		assert.equal(r.code, 0, r.stderr);
		assert.ok(fs.existsSync(path.join(ws.root, 'data', 'hr', 'positions', 'analyst.position.md')));
		const g = ws.dt('get', 'hr/position/analyst', '--json');
		assert.equal(g.code, 0, g.stderr);
		assert.equal(JSON.parse(g.stdout).name, 'Analyst');
	});

	test('the plural still answers exactly as before, and an unknown word is still "unknown collection"', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('add', 'tasks', '--name', 'plural').code, 0);
		const r = ws.dt('list', 'taks');
		assert.equal(r.code, 1);
		assert.match(r.stderr, /unknown collection "taks"/);
	});
});

describe('the positional title', () => {
	test('two positionals are refused by count, and a title given twice is refused by name', () => {
		const ws = twoModuleWorkspace();
		const two = ws.dt('add', 'task', 'one', 'two');
		assert.equal(two.code, 1);
		assert.match(two.stderr, /takes ONE positional \(the title\)/);
		const twice = ws.dt('add', 'task', 'one', '--name', 'two');
		assert.equal(twice.code, 1);
		assert.match(twice.stderr, /the title was given twice/);
		assert.ok(!fs.existsSync(path.join(ws.root, 'data', 'tasks', 'one.task.md')), 'a refused add still wrote a record');
	});
});

describe('references never learn the singular', () => {
	test('a record whose reference says task/<id> is a violation check reports', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('add', 'task', 'anchor').code, 0);
		assert.equal(ws.dt('add-field', 'people', '--name', 'owes', '--type', 'reference', '--target', 'tasks', '--description', 'A task this person owes.').code, 0);
		const bad = ws.dt('add', 'people', 'Ref Tester', '--owes', 'task/anchor');
		// the store validates the reference on write: the singular is not a collection a value may name
		assert.equal(bad.code, 1, bad.stdout);
		assert.match(bad.stderr, /task\/anchor/);
		const good = ws.dt('add', 'people', 'Ref Tester', '--owes', 'tasks/anchor');
		assert.equal(good.code, 0, good.stderr);
	});
});
