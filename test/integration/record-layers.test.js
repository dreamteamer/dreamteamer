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
import os from 'node:os';
import { workspace, writeModule, compileQuietly, compileError, readFile, git, dt } from '../helpers/ws.js';
import { Store } from '../../src/store.ts';
import { storageOf } from '../../src/descriptor.ts';
import { history } from '../../src/history.ts';
import { deriveEvents } from '../../src/events.ts';
import { load } from '../../src/yaml.ts';

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
		assert.match(dry.stdout, /^ {2}created {2}tasks\/write-the-brief {2}data\/tasks\/write-the-brief\.task\.md {2}· uncommitted$/m);
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
		const oneSha = /✔ git_modules\/project-a ([0-9a-f]{7}) — one$/m.exec(one.stdout)?.[1];
		assert.ok(oneSha, one.stdout);
		assert.match(one.stdout, new RegExp(`^ {2}updated {2}tasks/fix-login {2}git_modules/project-a/data/tasks/fix-login\\.task\\.md {2}· committed ${oneSha} · layer project-a$`, 'm'));
		assert.doesNotMatch(one.stdout, /workspace/);
		assert.match(git(a.layer, ['log', '-1', '--format=%s']), /^one$/);
		assert.match(git(a.w.root, ['status', '--porcelain', '-uall', 'data']), /\?\? data\/tasks\/write-the-brief\.task\.md/, "the workspace's own record is left pending");

		const b = layered();
		compileQuietly(b.w.ws);
		assert.equal(dt(b.w.root, 'set', 'tasks/fix-login', 'name=Fix the login flow').code, 0);
		assert.equal(dt(b.w.root, 'add', 'tasks', '--name', 'Write the brief').code, 0);
		const both = dt(b.w.root, 'commit', 'tasks', '-m', 'all tasks');
		assert.equal(both.code, 0, both.stderr);
		const wsSha = /✔ workspace ([0-9a-f]{7}) — all tasks$/m.exec(both.stdout)?.[1];
		const layerSha = /✔ git_modules\/project-a ([0-9a-f]{7}) — all tasks$/m.exec(both.stdout)?.[1];
		assert.ok(wsSha && layerSha, both.stdout);
		assert.match(both.stdout, new RegExp(`^ {2}created {2}tasks/write-the-brief {2}data/tasks/write-the-brief\\.task\\.md {2}· committed ${wsSha}$`, 'm'));
		assert.match(both.stdout, new RegExp(`^ {2}updated {2}tasks/fix-login {2}git_modules/project-a/data/tasks/fix-login\\.task\\.md {2}· committed ${layerSha} · layer project-a$`, 'm'));
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

const STUB_TASK = '---\nname: Fix login (placeholder)\nproject: projects/alpha\nstub: true\n---\n'; // the 0.41.0–0.44.x shape, now an ordinary record
const REAL_TASK = '---\nname: Fix login (the real one)\nproject: projects/alpha\n---\n';
const writeTop = (w, rel, body) => { fs.mkdirSync(path.dirname(path.join(w.root, rel)), { recursive: true }); fs.writeFileSync(path.join(w.root, rel), body); };
const getJson = (w, ref) => JSON.parse(dt(w.root, 'get', ref, '--json').stdout);

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

});


// ---- a workspace's own records resolve standalone (cr-dt-003) ---------------------------------------
// A workspace read as a layer is read WITHOUT its own layers, so every record of its own must resolve
// inside it. A stub is how it does that for an id only one of its layers holds — and a stub is a record
// of this workspace like any other: written with its mirrors, kept current by every owner write.

const CODES = 'name: codes\nstorage:\n  suffix: code\nids:\n  from: "{{ name | slug }}"\nfields:\n  name:\n    type: string\n    required: true\n  key:\n    type: string\n    required: true\n    unique: true\n';
const topTask = (w, slug, project) => writeTop(w, `data/tasks/${slug}.task.md`, `---\nname: ${slug}\nproject: ${project}\n---\n`);
const front = (w, rel) => load(/^---\n([\s\S]*?)\n---/.exec(readFile(w.root, rel))[1]);
/** layered() plus the shared `codes` collection (compiled from org, layered from project-a). */
// calls: a defaulted field and two conditional branches, the shape of a decision record
const CALLS = 'name: calls\nstorage:\n  suffix: call\nids:\n  from: "{{ name | slug }}"\nfields:\n  name:\n    type: string\n    required: true\n  by:\n    type: string\n    enum: [person, agent, unknown]\n    required: true\n  why:\n    type: string\n  source:\n    type: string\n  status:\n    type: string\n    enum: [open, done]\n    default: open\n  about:\n    type: projects\n    soft: true\n  pic:\n    type: pics\n  notes:\n    type: markdown\n    body: true\nconstraints:\n  - if: {required: [by], properties: {by: {enum: [person, agent]}}}\n    then: {required: [why]}\n  - if: {required: [by], properties: {by: {const: unknown}}}\n    then: {required: [source]}\n';
const MEMOS = 'name: memos\nstorage:\n  suffix: memo\nfields:\n  name:\n    type: string\n    required: true\n';
const PICS = 'name: pics\nstorage:\n  suffix: pic\n  format: binary\nfields: {}\n';
// projects with one defaulted field (cr-dt-003 only): a stub carries the schema's default, never the layer's value
const PROJECTS_D = PROJECTS.replace('  notes:\n', '  status:\n    type: string\n    enum: [a, b]\n    default: a\n  notes:\n');
/** layered() plus the shared collections the cr-dt-003 tests need — compiled from org, layered from
 *  project-a where `records` names them (memos is layerable but read from no layer). */
function standalone({ layerFiles = {}, records = ['tasks', 'projects', 'codes', 'calls', 'pics'], pkg = {} } = {}) {
	const out = layered({ records, pkg, layerFiles: {
		'data/codes/k1.code.md': '---\nname: k1\nkey: K1\n---\n', 'data/codes/k2.code.md': '---\nname: k2\nkey: K2\n---\n',
		'data/calls/c1.call.md': '---\nname: C1\nby: agent\nwhy: because\nsource: somewhere private\nstatus: done\n---\nA body nobody else should read.\n',
		'data/pics/p1.pic.png': 'not really a png',
		...layerFiles,
	} });
	for (const [n, y] of [['projects', PROJECTS_D], ['codes', CODES], ['calls', CALLS], ['memos', MEMOS], ['pics', PICS]]) fs.writeFileSync(path.join(out.org, 'collections', `${n}.collection.yaml`), y);
	return out;
}

describe("a workspace's own records resolve standalone (cr-dt-003)", () => {
	// T1 (rnd/tests/dreamteamer/cr-dt-003-t1)
	test('check names a target its own records reach only through a layer — one line, its referrers, the fix — and exits 0', () => {
		const { w } = standalone();
		topTask(w, 't-one', 'projects/alpha');
		topTask(w, 't-two', 'projects/alpha');
		compileQuietly(w.ws);
		const res = dt(w.root, 'check');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		const lines = res.stdout.split('\n').filter((l) => l.includes('projects/alpha'));
		assert.equal(lines.length, 1, res.stdout);
		assert.match(lines[0], /^⚠ projects\/alpha resolves only through layer project-a — named by 2 records here .* a workspace reading this one sees it dangle. dt exports$/);
		assert.match(lines[0], /\(tasks\/t-one, tasks\/t-two\)/);
	});

	test('at most three referrers are named, then +N more', () => {
		const { w } = standalone();
		for (const t of ['t1', 't2', 't3', 't4', 't5']) topTask(w, t, 'projects/alpha');
		compileQuietly(w.ws);
		assert.match(dt(w.root, 'check').stdout, /named by 5 records here \(tasks\/t1, tasks\/t2, tasks\/t3, \+2 more\)/);
	});

	// T2 (rnd/tests/dreamteamer/cr-dt-003-t2)
	test('the layer-only pass names nothing else: soft, mirror, a layer\'s own, an unlayerable referrer, no layers', () => {
		const annexDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dt-annex-')));
		process.on('exit', () => fs.rmSync(annexDir, { recursive: true, force: true }));
		const { w, org } = standalone({ pkg: { vars: ['JOTS_ANNEX'] } });
		fs.writeFileSync(path.join(w.root, '.env'), `JOTS_ANNEX=${annexDir}\n`);
		// unlayerable referrers (D11): a module-owned collection and an env-pointed one, each naming projects/alpha
		fs.writeFileSync(path.join(org, 'collections', 'briefs.collection.yaml'), 'name: briefs\nstorage:\n  suffix: brief\n  owner: module\nfields:\n  name:\n    type: string\n    required: true\n  project:\n    type: projects\n');
		writeTop({ root: org }, 'data/briefs/b1.brief.md', '---\nname: B1\nproject: projects/alpha\n---\n');
		fs.writeFileSync(path.join(org, 'collections', 'jots.collection.yaml'), 'name: jots\nstorage:\n  path: ${env:JOTS_ANNEX}/jots\n  suffix: jot\nfields:\n  name:\n    type: string\n    required: true\n  project:\n    type: projects\n');
		writeTop({ root: annexDir }, 'jots/j1.jot.md', '---\nname: J1\nproject: projects/alpha\n---\n');
		writeTop(w, 'data/calls/soft.call.md', '---\nname: Soft\nby: person\nwhy: w\nabout: projects/alpha\n---\n'); // soft: true
		writeTop(w, 'data/projects/beta.project.md', '---\nname: Beta\ntasks:\n  - tasks/fix-login\n---\n'); // a mirror naming a layer-only task
		compileQuietly(w.ws);
		assert.equal(dt(w.root, 'get', 'jots/j1').code, 0, 'the env-pointed referrer is actually read');
		assert.equal(dt(w.root, 'get', 'briefs/b1').code, 0, 'the module-owned referrer is actually read');
		const out = dt(w.root, 'check').stdout;
		assert.deepEqual(out.split('\n').filter((l) => l.includes('resolves only through')), [], out);

		const plain = workspace({ collections: { projects: { fields: { name: { type: 'string', required: true } } }, tasks: { fields: { name: { type: 'string', required: true }, project: { type: 'projects' } } } },
			records: { projects: [{ name: 'Alpha' }], tasks: [{ name: 'T', project: 'projects/alpha' }] } });
		const res = dt(plain.root, 'check');
		assert.equal(res.code, 0);
		assert.match(res.stdout, /^✔ 0 violations \(\d+ records across \d+ collections\)\n$/, 'a workspace with no layers prints exactly what it printed before');
		assert.equal(dt(plain.root, 'check', '--strict-export').stdout, res.stdout);
	});

});

// ---- cr-dt-004: stub records are removed (0.45.0) ---------------------------------------------------
// A `stub: true` record no longer yields: the field is gone from every schema, and a file carrying it is
// an ordinary record with an undeclared field — beside a layer's record of its id, the duplicate it is.
describe('stub records are removed (cr-dt-004)', () => {
	// T1 (rnd/tests/dreamteamer/cr-dt-004-t1)
	test('no compiled descriptor carries a stub field, and a record with stub: true is an unknown field', () => {
		const { w } = layered();
		writeTop(w, 'data/tasks/solo.task.md', '---\nname: Solo\nstub: true\n---\n');
		compileQuietly(w.ws);
		const store = new Store(w.ws);
		for (const name of store.descriptors.keys()) {
			const d = store.descriptor(name);
			assert.equal(d.compiled?.fields?.stub, undefined, `${name} compiles a stub field`);
			assert.equal(d.compiled?.json_schema?.properties?.stub, undefined, `${name}'s JSON Schema names stub`);
		}
		const res = dt(w.root, 'check');
		assert.equal(res.code, 1, res.stdout);
		assert.match(res.stdout, /✖ data\/tasks\/solo\.task\.md\n\s+unknown field "stub"/);
	});

	// T8 (rnd/tests/dreamteamer/cr-dt-004-t5)
	test('a write-root file carrying stub: true beside a layer\'s record is a duplicate: set and rm refuse naming both, the layer file untouched', () => {
		const { w } = layered();
		writeTop(w, 'data/tasks/fix-login.task.md', STUB_TASK);
		compileQuietly(w.ws);
		const before = readFile(w.root, 'git_modules/project-a/data/tasks/fix-login.task.md');
		for (const args of [['set', 'tasks/fix-login', 'name=Renamed'], ['rm', 'tasks/fix-login', '--force']]) {
			const res = dt(w.root, ...args);
			assert.equal(res.code, 1, `${args[0]}: ${res.stdout}${res.stderr}`);
			assert.match(res.stderr, /held by 2 files — data\/tasks\/fix-login\.task\.md and git_modules\/project-a\/data\/tasks\/fix-login\.task\.md/);
		}
		assert.equal(readFile(w.root, 'git_modules/project-a/data/tasks/fix-login.task.md'), before);
		assert.equal(readFile(w.root, 'data/tasks/fix-login.task.md'), STUB_TASK);
	});

	test('regression pin: two real records refuse the same way; an id only a layer holds is a layer write', () => {
		const { w } = layered();
		writeTop(w, 'data/tasks/fix-login.task.md', REAL_TASK);
		compileQuietly(w.ws);
		const res = dt(w.root, 'set', 'tasks/fix-login', 'name=Renamed');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /held by 2 files/);
		const own = dt(w.root, 'set', 'projects/alpha', 'name=Alpha Two');
		assert.equal(own.code, 0, own.stderr);
		assert.match(readFile(w.root, 'git_modules/project-a/data/projects/alpha.project.md'), /name: Alpha Two/);
	});

	// T12
	test('dt has no stub verb', () => {
		const { w } = layered();
		compileQuietly(w.ws);
		assert.doesNotMatch(dt(w.root, 'help').stdout, /^\s+stub\s/m);
		const res = dt(w.root, 'stub', 'projects/alpha');
		assert.notEqual(res.code, 0);
		assert.equal(fs.existsSync(`${w.root}/data/projects/alpha.project.md`), false);
	});
});
