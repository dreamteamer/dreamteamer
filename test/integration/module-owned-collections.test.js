// Per-collection data ownership — `storage.owner: module`.
//
// `owns_data: true` on a module moves EVERY one of its collections into the module's clone. A module
// that ships one shared list (people) and several per-workspace working sets (tasks, sessions) needs
// to say which is which, so the descriptor's storage block may name the owner: `module` keeps the
// records beside the module's sources and commits them to the module's repo; `workspace` (the
// default) keeps them in the workspace's data/. `owns_data: true` only moves the default.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, writeModule, writeCollection, patchModulePkg, compileQuietly, compileError, readFile, git, dt } from '../helpers/ws.js';
import { Store } from '../../src/store.js';
import { storageOf } from '../../src/descriptor.js';
import { history } from '../../src/history.js';

const PEOPLE = 'name: people\nstorage:\n  suffix: person\n  owner: module\nids:\n  from: "{{ name | slug }}"\nfields:\n  name:\n    type: string\n    required: true\n';
const TASKS = 'name: tasks\nstorage:\n  suffix: task\nids:\n  from: "{{ name | slug }}"\nfields:\n  name:\n    type: string\n    required: true\n  assignee:\n    type: people\n';

/** A git-channel module shipping `people` (owner: module) and `tasks` (the default). */
function withGitModule({ pkg = {}, people = PEOPLE, tasks = TASKS, init = true } = {}) {
	const w = workspace({ compile: false });
	const mod = path.join(w.root, 'git_modules', 'clinic');
	fs.mkdirSync(path.join(mod, 'collections'), { recursive: true });
	fs.writeFileSync(path.join(mod, 'package.json'), JSON.stringify({ name: 'clinic', version: '1.0.0', dreamteamer: pkg }, null, '\t'));
	fs.writeFileSync(path.join(mod, 'collections', 'people.collection.yaml'), people);
	fs.writeFileSync(path.join(mod, 'collections', 'tasks.collection.yaml'), tasks);
	if (init) {
		git(mod, ['init', '-q']);
		// a LOCAL identity, as the layer fixture carries: the store commits in this clone with the
		// process env, which on a CI runner has no git identity — the helper's GIT_AUTHOR_* never reach it
		git(mod, ['config', 'user.email', 'test@example.invalid']);
		git(mod, ['config', 'user.name', 'dreamteamer test']);
		git(mod, ['add', '-A']);
		git(mod, ['commit', '-qm', 'clinic']);
	}
	return { w, mod };
}

describe('storage.owner: module — one collection in the module clone, its sibling in the workspace', () => {
	test('the owned collection roots in the clone and commits to its repo; the other stays local', () => {
		const { w } = withGitModule();
		compileQuietly(w.ws);
		const store = new Store(w.ws);
		const people = storageOf(store.descriptor('people'));
		assert.equal(people.path, 'git_modules/clinic/data/people');
		assert.equal(people.repo, 'git_modules/clinic', "people belong to the module's repo");
		const tasks = storageOf(store.descriptor('tasks'));
		assert.equal(tasks.path, 'data/tasks');
		assert.equal(tasks.repo, '.', 'tasks belong to the workspace');
	});

	test('a workspace record may point at an owned one, and dt commit publishes each side in its own repo', () => {
		const { w, mod } = withGitModule();
		compileQuietly(w.ws);
		const store = new Store(w.ws);
		store.add('people', { name: 'Dana Levi' });
		store.add('tasks', { name: 'Call the lab', assignee: 'people/dana-levi' });
		assert.ok(readFile(w.root, 'git_modules/clinic/data/people/dana-levi.person.md'));
		assert.ok(readFile(w.root, 'data/tasks/call-the-lab.task.md'));
		assert.equal(w.ws && dt(w.root, 'check').code, 0, 'the cross-repo reference validates');

		const res = dt(w.root, 'commit', '-m', 'a person and her task');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.equal(git(mod, ['status', '--porcelain', 'data']), '', 'the module repo is clean');
		assert.equal(git(w.root, ['status', '--porcelain', 'data']), '', 'the workspace repo is clean');
		assert.match(git(mod, ['log', '-1', '--name-only', '--format=']), /data\/people\/dana-levi\.person\.md/);
		assert.match(git(w.root, ['log', '-1', '--name-only', '--format=']), /data\/tasks\/call-the-lab\.task\.md/);
	});

	test('owns_data: true is the default for every collection, and storage.owner: workspace opts one out', () => {
		const { w } = withGitModule({
			pkg: { owns_data: true },
			people: PEOPLE.replace('  owner: module\n', ''),
			tasks: TASKS.replace('  suffix: task\n', '  suffix: task\n  owner: workspace\n'),
		});
		compileQuietly(w.ws);
		const store = new Store(w.ws);
		assert.equal(storageOf(store.descriptor('people')).path, 'git_modules/clinic/data/people');
		assert.equal(storageOf(store.descriptor('tasks')).path, 'data/tasks');
		assert.equal(storageOf(store.descriptor('tasks')).repo, '.');
	});

	test('an overlay may not move a collection between repos', () => {
		const { w } = withGitModule();
		patchModulePkg(w.root, 'default', { dependencies: ['clinic'] });
		writeCollection(w.root, 'people', { overlay: true, storage: { owner: 'workspace' }, fields: {} });
		const pkg = JSON.parse(readFile(w.root, 'package.json'));
		// the SPECIFIC refusal: on an engine that did not know the key, /storage\.owner/ matched the
		// unknown-key error and this test passed without the guard existing
		assert.match(compileError({ root: w.root, pkg }), /an overlay may not set storage\.owner — which repo holds "people"'s records is declared by its base/);
	});

	test('a mirror may not span two repos: people (owner: module) mirroring tasks.assignee is refused', () => {
		const { w } = withGitModule({ people: PEOPLE + '  tasks:\n    type: tasks\n    many: true\n    mirror_of: assignee\n  notes:\n    type: markdown\n    body: true\n' });
		const pkg = JSON.parse(readFile(w.root, 'package.json'));
		assert.match(compileError({ root: w.root, pkg }), /collection "people": field "tasks" mirrors tasks\.assignee across two git repos/);
	});

	test('with auto-commit on, renaming an owned record a workspace record names commits once per repo', () => {
		const { w, mod } = withGitModule();
		const pkgPath = path.join(w.root, 'package.json');
		const pkg = JSON.parse(readFile(w.root, 'package.json'));
		pkg.dreamteamer.auto_commit = true;
		fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');
		w.ws.pkg = pkg;
		compileQuietly(w.ws);
		const store = new Store(w.ws);
		store.add('people', { name: 'Dana Levi' });
		store.add('tasks', { name: 'Call the lab', assignee: 'people/dana-levi' });
		const modBefore = git(mod, ['rev-list', '--count', 'HEAD']);
		const wsBefore = git(w.root, ['rev-list', '--count', 'HEAD']);
		const res = store.rename('people', 'dana-levi', 'dana-l');
		assert.equal(res.rewrites, 1);
		assert.ok(readFile(w.root, 'git_modules/clinic/data/people/dana-l.person.md'));
		assert.match(readFile(w.root, 'data/tasks/call-the-lab.task.md'), /assignee: people\/dana-l\n/);
		assert.equal(Number(git(mod, ['rev-list', '--count', 'HEAD'])), Number(modBefore) + 1, 'the module clone gained one commit');
		assert.equal(Number(git(w.root, ['rev-list', '--count', 'HEAD'])), Number(wsBefore) + 1, 'the workspace gained one commit');
		assert.match(git(w.root, ['log', '-1', '--name-only', '--format=']), /^data\/tasks\/call-the-lab\.task\.md$/m);
		assert.equal(git(mod, ['status', '--porcelain']), '');
		assert.equal(git(w.root, ['status', '--porcelain', 'data']), '');
	});

	test('history and revert of an owned record run git in the module clone', () => {
		const { w, mod } = withGitModule();
		compileQuietly(w.ws);
		const store = new Store(w.ws);
		store.add('people', { name: 'Dana Levi' });
		assert.equal(dt(w.root, 'commit', '-m', 'add dana').code, 0);
		const first = git(mod, ['rev-parse', 'HEAD']);
		const log = history(store, 'people', 'dana-levi');
		assert.equal(log.length, 1);
		assert.equal(log[0].hash, first);
		assert.equal(log[0].subject, 'add dana');
		store.set('people', 'dana-levi', { name: 'Dana L' });
		assert.equal(dt(w.root, 'commit', '-m', 'edit dana').code, 0);
		assert.equal(history(store, 'people', 'dana-levi').length, 2);
		const res = store.revert('people', 'dana-levi', first);
		assert.equal(res.reverted, true);
		assert.match(readFile(w.root, 'git_modules/clinic/data/people/dana-levi.person.md'), /name: Dana Levi\n/);
		const cli = dt(w.root, 'history', 'people/dana-levi');
		assert.equal(cli.code, 0, cli.stderr);
		assert.match(cli.stdout, /edit dana/);
	});

	test('a module whose records could never be committed is refused', () => {
		const { w } = withGitModule({ init: false });
		const pkg = JSON.parse(readFile(w.root, 'package.json'));
		assert.match(compileError({ root: w.root, pkg }), /not a git clone/);
	});

	test('storage.owner is module or workspace', () => {
		const { w } = withGitModule({ people: PEOPLE.replace('owner: module', 'owner: elsewhere') });
		const pkg = JSON.parse(readFile(w.root, 'package.json'));
		assert.match(compileError({ root: w.root, pkg }), /`storage\.owner` is module · workspace/);
	});
});

describe('dt rm modules/<id> and the records a module keeps inside itself', () => {
	const inline = () => {
		const w = workspace({ compile: false });
		writeModule(w.root, 'clinic', { collections: {
			people: { storage: { suffix: 'person', owner: 'module' }, ids: { from: '{{ name | slug }}' }, fields: { name: { type: 'string', required: true } } },
		} });
		git(w.root, ['add', '-A']);
		git(w.root, ['commit', '-qm', 'clinic']);
		compileQuietly(w.ws);
		return w;
	};

	test('refuses while an owned collection has records, and names where they are', () => {
		const w = inline();
		assert.equal(dt(w.root, 'add', 'people', '--name', 'Dana Levi').code, 0);
		assert.ok(readFile(w.root, 'modules/clinic/data/people/dana-levi.person.md'));
		const res = dt(w.root, 'rm', 'modules/clinic', '--force');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /people/);
		assert.match(res.stderr, /INSIDE modules\/clinic\/data/);
		assert.ok(readFile(w.root, 'modules/clinic/package.json'), 'nothing removed');
	});

	test('goes ahead once the owned collection is empty', () => {
		const w = inline();
		const res = dt(w.root, 'rm', 'modules/clinic', '--force');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.equal(fs.existsSync(path.join(w.root, 'modules', 'clinic')), false);
	});
});
