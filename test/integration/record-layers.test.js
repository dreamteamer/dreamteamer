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
import { deriveEvents } from '../../src/events.js';

const PEOPLE = 'name: people\nstorage:\n  suffix: person\n  owner: module\nids:\n  from: "{{ name | slug }}"\nfields:\n  name:\n    type: string\n    required: true\n  notes:\n    type: markdown\n    body: true\n';
const PROJECTS = 'name: projects\nstorage:\n  suffix: project\nids:\n  from: "{{ name | slug }}"\nfields:\n  name:\n    type: string\n    required: true\n  tasks:\n    type: tasks\n    many: true\n    mirror_of: project\n  notes:\n    type: markdown\n    body: true\n';
const TASKS = 'name: tasks\nstorage:\n  suffix: task\nids:\n  from: "{{ name | slug }}"\nfields:\n  name:\n    type: string\n    required: true\n  project:\n    type: projects\n  assignee:\n    type: people\n  notes:\n    type: markdown\n    body: true\n';

function commitAll(dir, msg) {
	git(dir, ['init', '-q']);
	// a LOCAL identity, as the base fixture carries: the store commits in this clone with the process
	// env, which on a CI runner has no git identity at all — the helper's own GIT_AUTHOR_* never reach it
	git(dir, ['config', 'user.email', 'test@example.invalid']);
	git(dir, ['config', 'user.name', 'dreamteamer test']);
	git(dir, ['add', '-A']);
	git(dir, ['commit', '-qm', msg]);
}

/** The shared-shape module `org` (a git module) and one project workspace clone `project-a` (a layer). */
function layered({ records = ['tasks', 'projects'], pkg = {}, layerFiles = {}, clone = true, entry = {}, layerModule = 'default' } = {}) {
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
		// a WORKSPACE: its own manifest, its own workspace module (unpacked here only with `module: true`),
		// its own data. `layerModule: null` is a clone whose manifest names no workspace module.
		const wm = layerModule ?? 'default';
		const mod = path.join(layer, 'modules', wm);
		fs.mkdirSync(path.join(mod, 'collections'), { recursive: true });
		fs.writeFileSync(path.join(layer, 'package.json'), JSON.stringify({ name: 'project-a', private: true, dreamteamer: { ...(layerModule ? { workspace_module: layerModule } : {}), data_path: 'data', git_modules: { org: { url: 'x', ref: 'main' } } } }, null, '\t'));
		fs.writeFileSync(path.join(mod, 'package.json'), JSON.stringify({ name: wm, description: "The project's own module.", dreamteamer: {} }, null, '\t'));
		fs.writeFileSync(path.join(mod, 'collections', 'secrets.collection.yaml'), 'name: secrets\nfields:\n  name:\n    type: string\n');
		fs.mkdirSync(path.join(mod, 'agents'), { recursive: true });
		fs.writeFileSync(path.join(mod, 'agents', 'project-runner.agent.md'), '---\nname: project-runner\ndescription: runs this project\'s checks\ntools: [Read, Bash]\n---\nrun the checks.\n');
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
	manifest.dreamteamer.git_modules = { org: { url: 'x', ref: 'main' }, 'project-a': { url: 'x', ref: 'main', ...(records ? { records } : {}), ...entry } };
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
		assert.equal(fs.existsSync(path.join(w.root, '.dreamteamer', 'agents', 'project-runner.agent.md')), false, "nor is its agent");
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

	test('get --json and list --json say where each record is read from and which repo commits it', () => {
		const { w } = layered();
		compileQuietly(w.ws);
		assert.equal(dt(w.root, 'add', 'tasks', '--name', 'Write the brief').code, 0);
		const got = (ref) => JSON.parse(dt(w.root, 'get', ref, '--json').stdout);
		const layer = got('tasks/fix-login');
		assert.equal(layer.$repo, 'git_modules/project-a');
		assert.equal(layer.$file, 'git_modules/project-a/data/tasks/fix-login.task.md');
		assert.equal(layer.name, 'Fix login', 'the record fields are still all there');
		const own = got('tasks/write-the-brief');
		assert.equal(own.$repo, '.');
		assert.equal(own.$file, 'data/tasks/write-the-brief.task.md');
		const shared = got('people/dana-levi');
		assert.equal(shared.$repo, 'git_modules/org', "a module-owned list's record commits in the module's clone");
		assert.equal(shared.$file, 'git_modules/org/data/people/dana-levi.person.md');
		const rows = JSON.parse(dt(w.root, 'list', 'tasks', '--json').stdout);
		assert.deepEqual(rows.map((r) => [r.id, r.$repo, r.$file]), [
			['write-the-brief', '.', 'data/tasks/write-the-brief.task.md'],
			['fix-login', 'git_modules/project-a', 'git_modules/project-a/data/tasks/fix-login.task.md'],
		]);
	});

	test('a write on a layer record names the repo it landed in; one in the workspace does not', () => {
		const { w } = layered();
		compileQuietly(w.ws);
		assert.equal(dt(w.root, 'add', 'tasks', '--name', 'Write the brief').code, 0);
		const layerSet = dt(w.root, 'set', 'tasks/fix-login', 'name=Fix the login flow');
		assert.equal(layerSet.code, 0, layerSet.stderr);
		assert.match(layerSet.stdout, /updated in git_modules\/project-a$/m);
		const ownSet = dt(w.root, 'set', 'tasks/write-the-brief', 'name=Write the short brief');
		assert.match(ownSet.stdout, /updated$/m);
		assert.doesNotMatch(ownSet.stdout, / in /);
		const json = JSON.parse(dt(w.root, 'set', 'tasks/fix-login', 'name=Fix login', '--json').stdout);
		assert.equal(json.$repo, 'git_modules/project-a');
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

	test('a declared layer whose clone is absent does not break dt commit: the dry run and a scoped commit of a workspace record both publish', () => {
		const { w } = layered({ clone: false });
		compileQuietly(w.ws);
		new Store(w.ws).add('tasks', { name: 'Write the brief' });
		const dry = dt(w.root, 'commit', '--dry-run');
		assert.equal(dry.code, 0, dry.stdout + dry.stderr);
		assert.match(dry.stdout, /add tasks\/write-the-brief/);
		const res = dt(w.root, 'commit', 'tasks/write-the-brief');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.equal(git(w.root, ['status', '--porcelain', 'data']), '', 'the record was published');
	});

	test("a mirror a layer holds, whose OWNERS this workspace does not read from that layer, is the layer's to judge: check is clean and rebuild leaves the clone untouched", () => {
		// projects is layered, tasks is not: alpha's `tasks: [tasks/fix-login]` is right in project-a's
		// own repo, and this workspace cannot see the owner that justifies it
		const { w, layer } = layered({ records: ['projects'] });
		compileQuietly(w.ws);
		const file = 'git_modules/project-a/data/projects/alpha.project.md';
		const before = readFile(w.root, file);
		const res = dt(w.root, 'check');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		const rebuilt = dt(w.root, 'relations', 'rebuild', 'projects');
		assert.equal(rebuilt.code, 0, rebuilt.stdout + rebuilt.stderr);
		assert.equal(readFile(w.root, file), before, 'rebuild wrote nothing into the layer clone');
		assert.equal(git(layer, ['status', '--porcelain']), '', 'the layer repo is clean');
	});

	test('a mirror in a layer whose owners ARE read from that layer is still judged: a stale one is reported, and rebuilt in place', () => {
		const { w } = layered({ layerFiles: { 'data/projects/alpha.project.md': '---\nname: Alpha\n---\n' } });
		compileQuietly(w.ws);
		const res = dt(w.root, 'check');
		assert.equal(res.code, 1, res.stdout + res.stderr);
		assert.match(res.stdout, /tasks: stale/);
		assert.equal(dt(w.root, 'relations', 'rebuild', 'projects').code, 0);
		assert.match(readFile(w.root, 'git_modules/project-a/data/projects/alpha.project.md'), /tasks\/fix-login/);
		assert.equal(dt(w.root, 'check').code, 0);
	});

	test('records must name collections the layer can contribute', () => {
		const a = layered({ records: ['tasks', 'nosuch'] });
		assert.match(compileError({ root: a.w.root, pkg: a.pkg }), /"nosuch"/);
		const b = layered({ records: ['people'] });
		assert.match(compileError({ root: b.w.root, pkg: b.pkg }), /people.*owner: module/);
	});
});

/** Wait for the wall clock to tick over a second. `dt changes` resolves a sha to its commit DATE and
 *  each repo resolves that date to its own sha with `--before`, which is inclusive at second
 *  precision — so a commit made in the SAME second as the baseline reads as part of it. */
function nextSecond() {
	const start = Math.floor(Date.now() / 1000);
	while (Math.floor(Date.now() / 1000) === start) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}

describe('record layers — the verbs an operator runs across one (0.36.0)', () => {
	test('a workspace-own record of a layered collection renames in the write root — store and CLI', () => {
		const { w } = layered();
		compileQuietly(w.ws);
		const store = new Store(w.ws);
		store.add('tasks', { name: 'Write the brief' });
		const res = store.rename('tasks', 'write-the-brief', 'write-brief');
		assert.equal(res.id, 'write-brief');
		assert.ok(fs.existsSync(path.join(w.root, 'data', 'tasks', 'write-brief.task.md')), 'the new file is in the write root');
		assert.equal(fs.existsSync(path.join(w.root, 'data', 'tasks', 'write-the-brief.task.md')), false, 'the old file is gone');
		const cli = dt(w.root, 'rename', 'tasks/write-brief', 'the-brief');
		assert.equal(cli.code, 0, cli.stderr);
		assert.deepEqual(fs.readdirSync(path.join(w.root, 'data', 'tasks')), ['the-brief.task.md']);
		assert.equal(dt(w.root, 'check').code, 0);
	});

	test('dt changes sees a commit made in a layer repo, attributed to that repo', () => {
		const { w, layer } = layered({ pkg: { auto_commit: true } });
		compileQuietly(w.ws);
		const since = git(w.root, ['rev-parse', 'HEAD']);
		nextSecond();
		const store = new Store(w.ws);
		store.set('tasks', 'fix-login', { name: 'Fix the login flow' });
		assert.match(git(layer, ['log', '-1', '--format=%s']), /tasks set fix-login/, 'the edit committed in the layer');
		const events = deriveEvents(w.root, store.descriptors, since);
		assert.deepEqual(events.map((e) => [e.type, e.collection, e.id, e.repo]), [['item-updated', 'tasks', 'fix-login', 'git_modules/project-a']]);
		const cli = JSON.parse(dt(w.root, 'changes', '--since', since, '--json').stdout);
		assert.equal(cli.events.length, 1);
		assert.equal(cli.events[0].path, 'git_modules/project-a/data/tasks/fix-login.task.md');
	});

	test('dt commit over three repos when the second refuses: the first is reported, the second reset, the third named as pending', () => {
		const { w, org, layer } = layered();
		compileQuietly(w.ws);
		assert.equal(dt(w.root, 'add', 'tasks', '--name', 'Write the brief').code, 0);            // workspace
		assert.equal(dt(w.root, 'add', 'people', '--name', 'Mallory Quinn').code, 0);            // git_modules/org
		assert.equal(dt(w.root, 'set', 'tasks/fix-login', 'name=Fix the login flow').code, 0);   // git_modules/project-a
		fs.mkdirSync(path.join(org, '.git', 'hooks'), { recursive: true });
		fs.writeFileSync(path.join(org, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho refused-by-hook >&2\nexit 1\n', { mode: 0o755 });
		const res = dt(w.root, 'commit', '-m', 'three');
		assert.equal(res.code, 1);
		assert.match(res.stdout, /✔ workspace [0-9a-f]{7} — three/, 'the commit that landed is reported');
		assert.match(res.stderr, /✖ git_modules\/org: .*1 record\(s\) left uncommitted/, 'the failing repo is named');
		assert.match(res.stdout + res.stderr, /git_modules\/project-a: 1 record\(s\) left pending/, 'the repo never reached is named');
		assert.match(git(w.root, ['log', '-1', '--format=%s']), /^three$/);
		assert.equal(git(org, ['status', '--porcelain']), '?? data/people/mallory-quinn.person.md', 'the failing repo has nothing staged');
		assert.match(git(layer, ['status', '--porcelain']), /^ ?M data\/tasks\/fix-login\.task\.md$/, 'the third repo is untouched: modified, nothing staged');
		assert.match(git(layer, ['log', '-1', '--format=%s']), /^project-a$/);
	});

	test('the read verbs span the layer: list, --where, get, status', () => {
		const { w } = layered();
		compileQuietly(w.ws);
		assert.equal(dt(w.root, 'add', 'tasks', '--name', 'Write the brief').code, 0);
		assert.equal(dt(w.root, 'list', 'tasks').stdout.trim(), 'write-the-brief\nfix-login');
		assert.equal(dt(w.root, 'list', 'tasks', '--where', '{"name":{"_contains":"login"}}').stdout.trim(), 'fix-login');
		const get = dt(w.root, 'get', 'tasks/fix-login');
		assert.equal(get.code, 0, get.stderr);
		assert.match(get.stdout, /name: Fix login/);
		assert.match(dt(w.root, 'status').stdout, /layers:\n\s+project-a\s+git_modules @ [0-9a-f]{7} · records: projects, tasks/);
	});

	test('dt commit <collection>/<id> on a layer record commits in the layer only; dt commit <collection> publishes one commit per repo', () => {
		const a = layered();
		compileQuietly(a.w.ws);
		assert.equal(dt(a.w.root, 'set', 'tasks/fix-login', 'name=Fix the login flow').code, 0);
		assert.equal(dt(a.w.root, 'add', 'tasks', '--name', 'Write the brief').code, 0);
		const one = dt(a.w.root, 'commit', 'tasks/fix-login', '-m', 'one');
		assert.equal(one.code, 0, one.stderr);
		assert.match(one.stdout, /✔ git_modules\/project-a [0-9a-f]{7} — one\n\s+set tasks\/fix-login/);
		assert.doesNotMatch(one.stdout, /workspace/);
		assert.match(git(a.layer, ['log', '-1', '--format=%s']), /^one$/);
		assert.match(git(a.w.root, ['status', '--porcelain', '-uall', 'data']), /\?\? data\/tasks\/write-the-brief\.task\.md/, "the workspace's own record is left pending");

		const b = layered();
		compileQuietly(b.w.ws);
		assert.equal(dt(b.w.root, 'set', 'tasks/fix-login', 'name=Fix the login flow').code, 0);
		assert.equal(dt(b.w.root, 'add', 'tasks', '--name', 'Write the brief').code, 0);
		const both = dt(b.w.root, 'commit', 'tasks', '-m', 'all tasks');
		assert.equal(both.code, 0, both.stderr);
		assert.match(both.stdout, /✔ workspace [0-9a-f]{7} — all tasks\n\s+add tasks\/write-the-brief/);
		assert.match(both.stdout, /✔ git_modules\/project-a [0-9a-f]{7} — all tasks\n\s+set tasks\/fix-login/);
		assert.equal(git(b.w.root, ['status', '--porcelain', 'data']), '');
		assert.equal(git(b.layer, ['status', '--porcelain', 'data']), '');
	});

	test('rm of a layer record lands in the layer: file gone, its project mirror detached there, one commit in the layer, the workspace untouched', () => {
		const { w, layer } = layered({ pkg: { auto_commit: true } });
		compileQuietly(w.ws);
		const store = new Store(w.ws);
		store.rm('tasks', 'fix-login');
		assert.equal(fs.existsSync(path.join(layer, 'data', 'tasks', 'fix-login.task.md')), false);
		assert.doesNotMatch(readFile(w.root, 'git_modules/project-a/data/projects/alpha.project.md'), /tasks\/fix-login/, 'the mirror in the layer lost its entry');
		assert.match(git(layer, ['log', '-1', '--format=%s']), /tasks rm fix-login/);
		assert.equal(git(layer, ['status', '--porcelain']), '', 'the layer repo is clean');
		assert.equal(git(w.root, ['status', '--porcelain', 'data']), '', 'the workspace repo is untouched');
		assert.equal(dt(w.root, 'check').code, 0);
	});
});

describe('a layer may also contribute its workspace module — `module: true` (0.37.0)', () => {
	const agent = (w) => path.join(w.root, '.dreamteamer', 'agents', 'project-runner.agent.md');

	test("with module: true the clone's workspace module compiles — its agent and collection land, it is a modules record, and its records still read as a layer", () => {
		const { w } = layered({ layerModule: 'project-a', entry: { module: true } });
		compileQuietly(w.ws);
		assert.ok(fs.existsSync(agent(w)), "the layer's agent compiles into .dreamteamer/agents/");
		const store = new Store(w.ws);
		assert.ok(store.descriptors.has('secrets'), "the layer module's collection compiles too");
		const rec = readFile(w.root, '.dreamteamer/modules/project-a.module.yaml');
		assert.ok(rec, 'the module is projected as modules/project-a');
		assert.match(rec, /location: git_modules/);
		assert.match(rec, /path: git_modules\/project-a\/modules\/project-a/);
		assert.deepEqual(storageOf(store.descriptor('tasks')).roots.map((r) => r.path), ['data/tasks', 'git_modules/project-a/data/tasks'], 'the records half is unchanged');
		assert.deepEqual([...store.ids('tasks').keys()], ['fix-login']);
		assert.equal(dt(w.root, 'check').code, 0);
	});

	test('without module: true a named workspace module is still not compiled', () => {
		const { w } = layered({ layerModule: 'project-a' });
		compileQuietly(w.ws);
		assert.equal(fs.existsSync(agent(w)), false);
		assert.equal(readFile(w.root, '.dreamteamer/modules/project-a.module.yaml'), null);
	});

	const refusal = (opts) => { const { w, pkg } = layered(opts); return compileError({ root: w.root, pkg }) ?? ''; };

	test('refused, naming the entry: a clone whose manifest names no workspace_module', () => {
		assert.match(refusal({ layerModule: null, entry: { module: true } }), /git_modules\.project-a\.module: the clone names no dreamteamer\.workspace_module/);
	});

	test('refused, naming the entry: a workspace module whose id is default', () => {
		assert.match(refusal({ entry: { module: true } }), /git_modules\.project-a\.module: the clone's workspace module is "default"/);
	});

	test('refused, naming the entry: a workspace module whose id another module holds', () => {
		assert.match(refusal({ layerModule: 'org', entry: { module: true } }), /git_modules\.project-a\.module: the clone's workspace module "org" collides with module "org" at git_modules\/org/);
	});

	test('module: true without records on a WORKSPACE clone (0.41.0): the module compiles and every collection both have is layered', () => {
		const { w } = layered({ records: null, layerModule: 'project-a', entry: { module: true } });
		compileQuietly(w.ws);
		assert.ok(fs.existsSync(agent(w)), "the layer's agent compiles");
		const store = new Store(w.ws);
		assert.deepEqual(storageOf(store.descriptor('tasks')).roots.map((r) => r.path), ['data/tasks', 'git_modules/project-a/data/tasks']);
	});

	test('refused, naming the entry: module: true without records on a clone whose manifest names no workspace_module', () => {
		assert.match(refusal({ records: null, layerModule: null, entry: { module: true } }), /git_modules\.project-a\.module: the clone names no dreamteamer\.workspace_module/);
	});

	test('refused, naming the entry: module that is not a boolean', () => {
		assert.match(refusal({ layerModule: 'project-a', entry: { module: 'yes' } }), /git_modules\.project-a\.module must be true or false/);
	});

	test('dt status names the module on the layer line and lists it with the modules', () => {
		const { w } = layered({ layerModule: 'project-a', entry: { module: true } });
		compileQuietly(w.ws);
		const out = dt(w.root, 'status').stdout;
		assert.match(out, /layers:\n\s+project-a\s+git_modules @ [0-9a-f]{7} · records: projects, tasks · module project-a\n/);
		assert.match(out, /modules:[\s\S]*\n\s+project-a\s+git_modules @ [0-9a-f]{7}/);
	});
});

describe('layer data is inherent: a clone that names its workspace_module is a layer without `records:` (0.41.0)', () => {
	test('a layer with no records: list reads every collection both have; its sources are still not compiled', () => {
		const { w } = layered({ records: null });
		const out = compileQuietly(w.ws);
		const store = new Store(w.ws);
		assert.deepEqual(storageOf(store.descriptor('tasks')).roots.map((r) => r.path), ['data/tasks', 'git_modules/project-a/data/tasks']);
		assert.deepEqual(storageOf(store.descriptor('projects')).roots.map((r) => r.path), ['data/projects', 'git_modules/project-a/data/projects']);
		assert.deepEqual([...store.ids('tasks').keys()], ['fix-login'], 'the layer record is read');
		assert.equal(store.descriptors.has('secrets'), false, "the layer's own module is not compiled — it is a workspace, not a bundle");
		assert.equal(fs.existsSync(path.join(w.root, '.dreamteamer', 'agents', 'project-runner.agent.md')), false);
		assert.doesNotMatch(out.warnings.join('\n'), /shadows/);
		const res = dt(w.root, 'check');
		assert.equal(res.code, 0, res.stdout + res.stderr);
	});

	test('a collection that cannot layer is skipped with an ℹ naming it and why, never a failure', () => {
		const { w } = layered({ records: null });
		const out = compileQuietly(w.ws); // people is `storage.owner: module`, and the layer holds data/people/
		assert.match(out.warnings.join('\n'), /ℹ layer project-a: people is not read from the layer — it is `storage\.owner: module`.*1 file in git_modules\/project-a\/data\/people/);
		const store = new Store(w.ws);
		assert.equal(storageOf(store.descriptor('people')).roots.length, 1);
		assert.equal(store.ids('people').has('mallory'), false);
	});

	test('a clone whose manifest names no workspace_module is still a bundle: its modules unpack, its data is not read', () => {
		const { w } = layered({
			records: null, layerModule: null,
			layerFiles: {
				'modules/widgets-kit/package.json': JSON.stringify({ name: 'widgets-kit', dreamteamer: {} }),
				'modules/widgets-kit/collections/widgets.collection.yaml': 'name: widgets\nids:\n  from: "{{ name | slug }}"\nfields:\n  name:\n    type: string\n    required: true\n',
			},
		});
		compileQuietly(w.ws);
		const store = new Store(w.ws);
		assert.ok(store.descriptors.has('widgets'), "the bundle's module compiles");
		assert.equal(storageOf(store.descriptor('tasks')).roots.length, 1, 'and its data is not layered');
	});

	test('a layer data folder for a collection this workspace does not have warns by name and file count, and compile succeeds', () => {
		const { w } = layered({
			records: null,
			layerFiles: {
				'data/gadgets/one.gadget.md': '---\nname: One\n---\n',
				'data/gadgets/two.gadget.md': '---\nname: Two\n---\n',
				'data/ops/runbooks/restart.runbook.md': '---\nname: Restart\n---\n',
			},
		});
		const out = compileQuietly(w.ws);
		assert.equal(out.code, 0);
		const warnings = out.warnings.join('\n');
		assert.match(warnings, /⚠ layer project-a: git_modules\/project-a\/data\/gadgets\/ holds 2 files and no collection here reads it/);
		assert.match(warnings, /⚠ layer project-a: git_modules\/project-a\/data\/ops\/ holds 1 file and no collection here reads it/);
		assert.doesNotMatch(warnings, /data\/tasks\/ holds/, 'a folder a collection reads is never named');
	});

	test('records: present still NARROWS: only the listed collections are layered, and an excluded folder of a collection this workspace has is not warned about', () => {
		const { w } = layered({ records: ['tasks'] });
		const out = compileQuietly(w.ws);
		const store = new Store(w.ws);
		assert.equal(storageOf(store.descriptor('tasks')).roots.length, 2);
		assert.equal(storageOf(store.descriptor('projects')).roots.length, 1, 'projects is narrowed out');
		assert.doesNotMatch(out.warnings.join('\n'), /data\/projects\/ holds/);
	});

	test('dt status prints the collections FOUND in the layer, not a declared list', () => {
		const { w } = layered({ records: null });
		compileQuietly(w.ws);
		assert.match(dt(w.root, 'status').stdout, /layers:\n\s+project-a\s+git_modules @ [0-9a-f]{7} · records: projects, tasks\n/);
	});
});

/** One more workspace clone under git_modules/, read as an inherent layer (it names its workspace
 *  module), holding `files`. */
function addLayer(w, name, files) {
	const dir = path.join(w.root, 'git_modules', name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, private: true, dreamteamer: { workspace_module: name } }, null, '\t'));
	for (const [rel, body] of Object.entries(files)) {
		fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), body);
	}
	commitAll(dir, name);
	const pkgPath = path.join(w.root, 'package.json');
	const manifest = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	manifest.dreamteamer.git_modules[name] = { url: 'x', ref: 'main' };
	fs.writeFileSync(pkgPath, JSON.stringify(manifest, null, '\t') + '\n');
	w.ws.pkg = manifest;
	return dir;
}

const STUB_TASK = '---\nname: Fix login (placeholder)\nproject: projects/alpha\nstub: true\n---\n';
const REAL_TASK = '---\nname: Fix login (the real one)\nproject: projects/alpha\n---\n';
const writeTop = (w, rel, body) => { fs.mkdirSync(path.dirname(path.join(w.root, rel)), { recursive: true }); fs.writeFileSync(path.join(w.root, rel), body); };
const getJson = (w, ref) => JSON.parse(dt(w.root, 'get', ref, '--json').stdout);

describe('record-level stubs: a record carrying `stub: true` yields to any non-stub of its id, in any root (0.41.0)', () => {
	test('a stub in the LAYER yields to a non-stub in the top: get answers the top, check is clean and counts the shadowed stub', () => {
		const { w } = layered({ layerFiles: { 'data/tasks/fix-login.task.md': STUB_TASK } });
		writeTop(w, 'data/tasks/fix-login.task.md', REAL_TASK);
		compileQuietly(w.ws);
		const got = getJson(w, 'tasks/fix-login');
		assert.equal(got.name, 'Fix login (the real one)');
		assert.equal(got.$file, 'data/tasks/fix-login.task.md');
		assert.deepEqual(got.$shadows, ['git_modules/project-a/data/tasks/fix-login.task.md']);
		assert.equal(got.$stub, undefined);
		const res = dt(w.root, 'check');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.match(res.stdout, /ℹ 1 stub record shadowed by a real record of its id/);
		// the shadowed stub is still an OWNER in its own repo: the layer's alpha lists it, check expects
		// that, and rebuild must not strip it
		const alpha = readFile(w.root, 'git_modules/project-a/data/projects/alpha.project.md');
		assert.match(alpha, /tasks\/fix-login/);
		assert.equal(dt(w.root, 'relations', 'rebuild', 'projects').code, 0);
		assert.equal(readFile(w.root, 'git_modules/project-a/data/projects/alpha.project.md'), alpha, 'rebuild left the stub-justified mirror alone');
	});

	test('a stub in the TOP yields to a non-stub in a layer — direction does not matter', () => {
		const { w } = layered({ layerFiles: { 'data/tasks/fix-login.task.md': REAL_TASK } });
		writeTop(w, 'data/tasks/fix-login.task.md', STUB_TASK);
		compileQuietly(w.ws);
		const got = getJson(w, 'tasks/fix-login');
		assert.equal(got.$file, 'git_modules/project-a/data/tasks/fix-login.task.md');
		assert.deepEqual(got.$shadows, ['data/tasks/fix-login.task.md']);
		assert.equal(dt(w.root, 'check').code, 0);
		// a write goes to the winner, in its own repo — the stub is never the target
		const set = dt(w.root, 'set', 'tasks/fix-login', 'name=Fix login, edited');
		assert.equal(set.code, 0, set.stderr);
		assert.match(set.stdout, /updated in git_modules\/project-a$/m);
		assert.match(readFile(w.root, 'git_modules/project-a/data/tasks/fix-login.task.md'), /Fix login, edited/);
		assert.equal(readFile(w.root, 'data/tasks/fix-login.task.md'), STUB_TASK, 'the stub is untouched');
	});

	test('across two layers: a stub in the first yields to a non-stub in the second', () => {
		const { w } = layered({ layerFiles: { 'data/tasks/fix-login.task.md': STUB_TASK } });
		addLayer(w, 'project-b', { 'data/tasks/fix-login.task.md': REAL_TASK });
		compileQuietly(w.ws);
		const got = getJson(w, 'tasks/fix-login');
		assert.equal(got.$file, 'git_modules/project-b/data/tasks/fix-login.task.md');
		assert.equal(got.name, 'Fix login (the real one)');
		assert.deepEqual(dt(w.root, 'list', 'tasks').stdout.trim().split('\n'), ['fix-login'], 'one id, listed once');
		const res = dt(w.root, 'check');
		assert.equal(res.code, 0, res.stdout + res.stderr);
	});

	test('two non-stubs are still a violation, whatever stubs sit beside them, and a write is refused', () => {
		const { w } = layered(); // the layer's fix-login is a real record
		writeTop(w, 'data/tasks/fix-login.task.md', REAL_TASK);
		addLayer(w, 'project-b', { 'data/tasks/fix-login.task.md': STUB_TASK });
		compileQuietly(w.ws);
		const res = dt(w.root, 'check');
		assert.equal(res.code, 1);
		assert.match(res.stdout, /holds the id "fix-login" twice — data\/tasks\/fix-login\.task\.md and git_modules\/project-a\/data\/tasks\/fix-login\.task\.md/);
		assert.doesNotMatch(res.stdout, /project-b\/data\/tasks\/fix-login\.task\.md\. Remove one/, 'the stub is not one of the conflicting claimants');
		assert.throws(() => new Store(w.ws).set('tasks', 'fix-login', { name: 'x' }), /held by 2 files/);
	});

	test('stubs only: the first root answers, check is clean, and the stub is marked $stub', () => {
		const { w } = layered({ layerFiles: { 'data/tasks/fix-login.task.md': STUB_TASK } });
		writeTop(w, 'data/tasks/fix-login.task.md', '---\nname: Fix login (top placeholder)\nstub: true\n---\n');
		compileQuietly(w.ws);
		const got = getJson(w, 'tasks/fix-login');
		assert.equal(got.$file, 'data/tasks/fix-login.task.md');
		assert.equal(got.$stub, true);
		const res = dt(w.root, 'check');
		assert.equal(res.code, 0, res.stdout + res.stderr);
	});

	test('add where only stubs hold the id is allowed — it promotes the stub — and says what it shadows', () => {
		const { w } = layered({ layerFiles: { 'data/tasks/fix-login.task.md': STUB_TASK } });
		compileQuietly(w.ws);
		const res = dt(w.root, 'add', 'tasks', '--name', 'Fix login');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /✔ .*data\/tasks\/fix-login\.task\.md/);
		assert.match(res.stdout, /shadows 1 stub \(project-a\)/);
		assert.equal(getJson(w, 'tasks/fix-login').$file, 'data/tasks/fix-login.task.md');
		assert.equal(dt(w.root, 'check').code, 0);
		// a real record still refuses a second real one
		assert.match(dt(w.root, 'add', 'tasks', '--name', 'Fix login').stderr, /already exists/);
	});

	test('rm of the winner says which stub now shows, and the stub answers', () => {
		const { w } = layered({ layerFiles: { 'data/tasks/fix-login.task.md': STUB_TASK } });
		writeTop(w, 'data/tasks/fix-login.task.md', REAL_TASK);
		compileQuietly(w.ws);
		const res = dt(w.root, 'rm', 'tasks/fix-login');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /stub in layer project-a now shows \(git_modules\/project-a\/data\/tasks\/fix-login\.task\.md\)/);
		const got = getJson(w, 'tasks/fix-login');
		assert.equal(got.$file, 'git_modules/project-a/data/tasks/fix-login.task.md');
		assert.equal(got.$stub, true);
	});

	test('`stub` is engine-owned: every collection has it, and a module may not author it', () => {
		const { w } = layered();
		compileQuietly(w.ws);
		const f = new Store(w.ws).descriptor('tasks').compiled.fields.stub;
		assert.equal(f.type, 'boolean');
		assert.deepEqual(f.display.hidden, ['list', 'form']);
		const { w: w2, pkg } = layered();
		fs.writeFileSync(path.join(w2.root, 'git_modules', 'org', 'collections', 'tasks.collection.yaml'), TASKS + '  stub:\n    type: boolean\n');
		assert.match(compileError({ root: w2.root, pkg }) ?? '', /field "stub" is injected by the engine and cannot be authored/);
	});
});

describe('review round 1 (0.41.0)', () => {
	test('a layer declared WITHOUT records: whose clone is absent is announced by compile, check and status', () => {
		const { w } = layered({ records: null, clone: false });
		const out = compileQuietly(w.ws);
		assert.match(out.warnings.join('\n'), /⚠ layer project-a \(git_modules\/project-a\) is not installed — its records are not read; run dreamteamer install/);
		const res = dt(w.root, 'check');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.match(res.stdout, /layer project-a.*not installed/);
		assert.match(dt(w.root, 'status').stdout, /layers:\n\s+project-a\s+not installed — dreamteamer install/);
	});

	test("the reader's check validates a stub it holds even while a layer's real record answers the id", () => {
		const { w } = layered({ layerFiles: { 'data/tasks/fix-login.task.md': REAL_TASK } });
		writeTop(w, 'data/tasks/fix-login.task.md', '---\nstub: true\nlane: mobile\n---\n'); // no name (required), an unknown field
		compileQuietly(w.ws);
		const res = dt(w.root, 'check');
		assert.equal(res.code, 1, res.stdout);
		assert.match(res.stdout, /✖ data\/tasks\/fix-login\.task\.md\n[\s\S]*name/);
		assert.match(res.stdout, /unknown field "lane"/);
	});

	test('rm of the record that answers over a stub is not refused for references the stub keeps resolving, and never calls them dangling', () => {
		const { w } = layered({ layerFiles: {
			'data/projects/beta.project.md': '---\nname: Beta\nstub: true\ntasks:\n  - tasks/ship\n---\n',
			'data/tasks/ship.task.md': '---\nname: Ship\nproject: projects/beta\n---\n',
		} });
		writeTop(w, 'data/projects/beta.project.md', '---\nname: Beta\n---\n');
		compileQuietly(w.ws);
		assert.equal(dt(w.root, 'check').code, 0);
		const res = dt(w.root, 'rm', 'projects/beta');
		assert.equal(res.code, 0, res.stderr);
		assert.doesNotMatch(res.stdout, /dangling/);
		assert.match(res.stdout, /1 inbound reference\(s\) now resolve to the stub; stub in layer project-a now shows \(git_modules\/project-a\/data\/projects\/beta\.project\.md\)/);
		assert.match(readFile(w.root, 'git_modules/project-a/data/tasks/ship.task.md'), /project: projects\/beta/, 'the reference is untouched');
		assert.equal(dt(w.root, 'check').code, 0);
	});

	test('a long-lived Store notices a stub: flag flipped in place and answers the new winner', () => {
		const { w } = layered({ layerFiles: { 'data/tasks/fix-login.task.md': STUB_TASK } });
		writeTop(w, 'data/tasks/fix-login.task.md', REAL_TASK);
		compileQuietly(w.ws);
		const store = new Store(w.ws);
		assert.equal(store.locate('tasks', 'fix-login').file, 'data/tasks/fix-login.task.md');
		// the editor's shape: both files rewritten in place — no folder moves, HEAD does not move
		fs.writeFileSync(path.join(w.root, 'data/tasks/fix-login.task.md'), STUB_TASK);
		fs.writeFileSync(path.join(w.root, 'git_modules/project-a/data/tasks/fix-login.task.md'), REAL_TASK);
		assert.equal(store.locate('tasks', 'fix-login').file, 'git_modules/project-a/data/tasks/fix-login.task.md');
		assert.deepEqual(store.shadowedStubs('tasks', 'fix-login').map((f) => path.relative(w.root, f)), ['data/tasks/fix-login.task.md']);
	});

	test('stub is injected only into collections that can be layered: a module-owned one has no stub field', () => {
		const { w } = layered();
		compileQuietly(w.ws);
		const store = new Store(w.ws);
		assert.ok(store.descriptor('tasks').compiled.fields.stub, 'a layerable collection carries it');
		assert.equal(store.descriptor('people').compiled.fields.stub, undefined, '`storage.owner: module` can never be a layer root');
	});
});

