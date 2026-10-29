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
		assert.match(dt(w.root, 'status').stdout, /layers:\n\s+project-a\s+git_modules @ [0-9a-f]{7} · records: tasks, projects/);
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

	test('refused, naming the entry: module: true without records — a plain entry is already a bundle', () => {
		assert.match(refusal({ records: null, layerModule: 'project-a', entry: { module: true } }), /git_modules\.project-a\.module: true without `records` — an entry without records is already a bundle/);
	});

	test('refused, naming the entry: module that is not a boolean', () => {
		assert.match(refusal({ layerModule: 'project-a', entry: { module: 'yes' } }), /git_modules\.project-a\.module must be true or false/);
	});

	test('dt status names the module on the layer line and lists it with the modules', () => {
		const { w } = layered({ layerModule: 'project-a', entry: { module: true } });
		compileQuietly(w.ws);
		const out = dt(w.root, 'status').stdout;
		assert.match(out, /layers:\n\s+project-a\s+git_modules @ [0-9a-f]{7} · records: tasks, projects · module project-a\n/);
		assert.match(out, /modules:[\s\S]*\n\s+project-a\s+git_modules @ [0-9a-f]{7}/);
	});
});
