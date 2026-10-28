// Record layers — a workspace cloned under git_modules/ contributes its RECORDS, never its sources.
//
// An HQ workspace and several project workspaces install one module for their shared shapes; each
// project's task records live in its own repo. The HQ names the project clone in `git_modules` with
// a `records` list, and every listed collection gains that clone's data folder as a read root below
// the HQ's own: reads are the union, a new record goes to the write root, an edit of a layer record
// lands in place and commits in the layer's repo, and an id two roots hold is a violation.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, writeModule, compileQuietly, compileError, readFile, git, dt } from '../helpers/ws.js';
import { Store } from '../../src/store.js';
import { storageOf } from '../../src/descriptor.js';
import { history } from '../../src/history.js';

const PEOPLE = 'name: people\nstorage:\n  suffix: person\n  owner: module\nids:\n  from: "{{ name | slug }}"\nfields:\n  name:\n    type: string\n    required: true\n  notes:\n    type: markdown\n    body: true\n';
const PROJECTS = 'name: projects\nstorage:\n  suffix: project\nids:\n  from: "{{ name | slug }}"\nfields:\n  name:\n    type: string\n    required: true\n  tasks:\n    type: tasks\n    many: true\n    mirror_of: project\n  notes:\n    type: markdown\n    body: true\n';
const TASKS = 'name: tasks\nstorage:\n  suffix: task\nids:\n  from: "{{ name | slug }}"\nfields:\n  name:\n    type: string\n    required: true\n  project:\n    type: projects\n  assignee:\n    type: people\n  notes:\n    type: markdown\n    body: true\n';

function commitAll(dir, msg) {
	git(dir, ['init', '-q']);
	git(dir, ['add', '-A']);
	git(dir, ['commit', '-qm', msg]);
}

/** The shared-shape module `org` (a git module) and one project workspace clone `project-a` (a layer). */
function layered({ records = ['tasks', 'projects'], pkg = {}, layerFiles = {}, clone = true } = {}) {
	const w = workspace({ compile: false, pkg });
	const org = path.join(w.root, 'git_modules', 'org');
	fs.mkdirSync(path.join(org, 'collections'), { recursive: true });
	fs.writeFileSync(path.join(org, 'package.json'), JSON.stringify({ name: 'org', version: '1.0.0', dreamteamer: {} }, null, '\t'));
	fs.writeFileSync(path.join(org, 'collections', 'people.collection.yaml'), PEOPLE);
	fs.writeFileSync(path.join(org, 'collections', 'projects.collection.yaml'), PROJECTS);
	fs.writeFileSync(path.join(org, 'collections', 'tasks.collection.yaml'), TASKS);
	fs.mkdirSync(path.join(org, 'data', 'people'), { recursive: true });
	fs.writeFileSync(path.join(org, 'data', 'people', 'dana-levi.person.md'), '---\nname: Dana Levi\n---\n');
	commitAll(org, 'org');

	const layer = path.join(w.root, 'git_modules', 'project-a');
	if (clone) {
		// a WORKSPACE: its own manifest, its own default module (which must not be unpacked here), its own data
		fs.mkdirSync(path.join(layer, 'modules', 'default', 'collections'), { recursive: true });
		fs.writeFileSync(path.join(layer, 'package.json'), JSON.stringify({ name: 'project-a', private: true, dreamteamer: { workspace_module: 'default', data_path: 'data', git_modules: { org: { url: 'x', ref: 'main' } } } }, null, '\t'));
		fs.writeFileSync(path.join(layer, 'modules', 'default', 'package.json'), JSON.stringify({ name: 'default', dreamteamer: {} }, null, '\t'));
		fs.writeFileSync(path.join(layer, 'modules', 'default', 'collections', 'secrets.collection.yaml'), 'name: secrets\nfields:\n  name:\n    type: string\n');
		const files = {
			'data/tasks/fix-login.task.md': '---\nname: Fix login\nproject: projects/alpha\nassignee: people/dana-levi\n---\n',
			'data/projects/alpha.project.md': '---\nname: Alpha\ntasks:\n  - tasks/fix-login\n---\n',
			'data/people/mallory.person.md': '---\nname: Mallory\n---\n',
			...layerFiles,
		};
		for (const [rel, body] of Object.entries(files)) {
			fs.mkdirSync(path.join(layer, path.dirname(rel)), { recursive: true });
			fs.writeFileSync(path.join(layer, rel), body);
		}
		commitAll(layer, 'project-a');
	}

	const pkgPath = path.join(w.root, 'package.json');
	const manifest = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	manifest.dreamteamer.git_modules = { org: { url: 'x', ref: 'main' }, 'project-a': { url: 'x', ref: 'main', records } };
	fs.writeFileSync(pkgPath, JSON.stringify(manifest, null, '\t') + '\n');
	git(w.root, ['add', '-A']);
	git(w.root, ['commit', '-qm', 'manifest']);
	w.ws.pkg = manifest; // the helper captured the manifest before this edit
	return { w, org, layer, pkg: manifest };
}

describe('a layer contributes records, never sources', () => {
	test('the listed collections gain the clone as a read root; the clone is not unpacked as a bundle', () => {
		const { w } = layered();
		const out = compileQuietly(w.ws);
		const store = new Store(w.ws);
		const tasks = storageOf(store.descriptor('tasks'));
		assert.deepEqual(tasks.roots, [
			{ path: 'data/tasks', repo: '.' },
			{ path: 'git_modules/project-a/data/tasks', repo: 'git_modules/project-a', layer: 'project-a' },
		]);
		assert.equal(storageOf(store.descriptor('people')).roots.length, 1, 'an unlisted collection has no layer');
		assert.equal(store.descriptors.has('secrets'), false, "the layer's own module is not compiled");
		assert.doesNotMatch(String(out), /shadows/, 'no shadow warning either');
	});

	test('reads are the union, top first', () => {
		const { w } = layered();
		compileQuietly(w.ws);
		const store = new Store(w.ws);
		store.add('tasks', { name: 'Write the brief' });
		assert.deepEqual([...store.ids('tasks').keys()], ['write-the-brief', 'fix-login']);
		assert.match(store.read('tasks', 'fix-login').file, /git_modules\/project-a\/data\/tasks/);
		assert.equal(store.ids('people').has('mallory'), false, 'an unlisted collection is not read from the layer');
		assert.equal(dt(w.root, 'check').code, 0);
	});

	test('a new record goes to the write root; an id a layer holds is refused', () => {
		const { w } = layered();
		compileQuietly(w.ws);
		const store = new Store(w.ws);
		const { file } = store.add('tasks', { name: 'Write the brief' });
		assert.equal(path.relative(w.root, file), path.join('data', 'tasks', 'write-the-brief.task.md'));
		assert.throws(() => store.add('tasks', { name: 'Fix login' }), /tasks\/fix-login already exists/);
	});

	test('an edit of a layer record lands in place and dt commit publishes it in the layer repo', () => {
		const { w, layer } = layered();
		compileQuietly(w.ws);
		assert.equal(dt(w.root, 'set', 'tasks/fix-login', 'name=Fix the login flow').code, 0);
		assert.match(readFile(w.root, 'git_modules/project-a/data/tasks/fix-login.task.md'), /Fix the login flow/);
		const dry = dt(w.root, 'commit', '--dry-run');
		assert.match(dry.stdout, /tasks\/fix-login/, 'the pending layer edit is seen, not reported as nothing pending');
		const res = dt(w.root, 'commit', '-m', 'edit');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.equal(git(layer, ['status', '--porcelain', 'data']), '', 'the layer repo is clean');
		assert.match(git(layer, ['log', '-1', '--format=%s']), /edit/);
	});

	test('with auto-commit on, a set of a layer record commits in the layer repo', () => {
		const { w, layer } = layered({ pkg: { auto_commit: true } });
		compileQuietly(w.ws);
		const store = new Store(w.ws);
		store.set('tasks', 'fix-login', { name: 'Fix the login flow' });
		assert.equal(git(layer, ['status', '--porcelain', 'data']), '');
		assert.match(git(layer, ['log', '-1', '--format=%s']), /tasks set fix-login/);
	});

	test('rename and rm refuse to move a layer record between repos; rm of a record a layer names refuses', () => {
		const { w } = layered();
		compileQuietly(w.ws);
		const store = new Store(w.ws);
		assert.throws(() => store.rename('tasks', 'fix-login', 'fix-the-login'), /layer project-a/);
		// dana is named by the layer's task — the inbound guard sees the layer
		assert.throws(() => store.rm('people', 'dana-levi'), /tasks\/fix-login/);
	});

	test('an id held by two roots is a check violation and refuses writes', () => {
		const { w } = layered();
		compileQuietly(w.ws);
		fs.mkdirSync(path.join(w.root, 'data', 'tasks'), { recursive: true });
		fs.writeFileSync(path.join(w.root, 'data', 'tasks', 'fix-login.task.md'), '---\nname: Fix login (again)\n---\n');
		const res = dt(w.root, 'check');
		assert.equal(res.code, 1);
		assert.match(res.stdout, /holds the id "fix-login" twice/);
		const store = new Store(w.ws);
		assert.throws(() => store.set('tasks', 'fix-login', { name: 'x' }), /held by 2 files/);
	});

	test('mirrors stay inside a root: a top task naming a layer project writes no mirror into the layer, and check is clean', () => {
		const { w } = layered();
		compileQuietly(w.ws);
		const before = readFile(w.root, 'git_modules/project-a/data/projects/alpha.project.md');
		const store = new Store(w.ws);
		store.add('tasks', { name: 'Ship it', project: 'projects/alpha' });
		assert.equal(readFile(w.root, 'git_modules/project-a/data/projects/alpha.project.md'), before, 'the layer record is untouched');
		assert.equal(dt(w.root, 'check').code, 0, 'no stale mirror is reported in either direction');
	});

	test("a layer's violations are reported in their own section, naming the layer", () => {
		const { w } = layered({ layerFiles: { 'data/tasks/odd.task.md': '---\nname: Odd\nlane: mobile\n---\n' } });
		compileQuietly(w.ws);
		const res = dt(w.root, 'check');
		assert.equal(res.code, 1);
		assert.match(res.stdout, /layer project-a/);
		assert.match(res.stdout, /unknown field "lane"/);
	});

	test('history and revert of a layer record run git in the layer repo', () => {
		const { w, layer } = layered();
		compileQuietly(w.ws);
		const store = new Store(w.ws);
		const first = git(layer, ['rev-parse', 'HEAD']);
		store.set('tasks', 'fix-login', { name: 'Fix the login flow' });
		git(layer, ['add', '-A']); git(layer, ['commit', '-qm', 'edit']);
		const log = history(store, 'tasks', 'fix-login');
		assert.equal(log.length, 2);
		const res = store.revert('tasks', 'fix-login', first);
		assert.equal(res.reverted, true);
		assert.match(readFile(w.root, 'git_modules/project-a/data/tasks/fix-login.task.md'), /name: Fix login\n/);
	});

	test('a layer whose clone is not on disk compiles, and check says it is unread', () => {
		const { w } = layered({ clone: false });
		compileQuietly(w.ws);
		const res = dt(w.root, 'check');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.match(res.stdout, /layer project-a.*not installed/);
	});

	test('records must name collections the layer can contribute', () => {
		const a = layered({ records: ['tasks', 'nosuch'] });
		assert.match(compileError({ root: a.w.root, pkg: a.pkg }), /"nosuch"/);
		const b = layered({ records: ['people'] });
		assert.match(compileError({ root: b.w.root, pkg: b.pkg }), /people.*owner: module/);
	});
});
