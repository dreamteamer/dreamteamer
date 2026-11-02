// Cross-repo references without stub records (cr-dt-004): `dreamteamer-exports.json`, `dt exports`,
// external references in `dt check`, and `dt get` / `Store.external`. The design's T-numbers are named
// on each test. Every fixture is synthetic: a shapes clone `org`, a workspace W, its layer L, and a
// reader R that reads W (as a copy of W's committed tree) and never W's layers.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, compileQuietly, readFile, git, dt } from '../helpers/ws.js';
import { Store } from '../../src/store.js';
import { serializeExports } from '../../src/exports.js';

const PEOPLE = 'name: people\nstorage:\n  suffix: person\nids:\n  from: "{{ name | slug }}"\nfields:\n  name:\n    type: string\n    required: true\n';
const PROJECTS = 'name: projects\nstorage:\n  suffix: project\nids:\n  from: "{{ name | slug }}"\nfields:\n  name:\n    type: string\n    required: true\n';
const TASKS = 'name: tasks\nstorage:\n  suffix: task\nids:\n  from: "{{ name | slug }}"\nfields:\n  name:\n    type: string\n    required: true\n  project:\n    type: projects\n  assignee:\n    type: people\n  pic:\n    type: pics\n';
const PICS = 'name: pics\nstorage:\n  suffix: pic\n  format: binary\nfields: {}\n';
const BRIEFS = 'name: briefs\nstorage:\n  suffix: brief\n  owner: module\nfields:\n  name:\n    type: string\n    required: true\n  lead:\n    type: people\n';
const MANIFEST = 'dreamteamer-exports.json';

function commitAll(dir, msg) {
	if (!fs.existsSync(path.join(dir, '.git'))) {
		git(dir, ['init', '-q']);
		git(dir, ['config', 'user.email', 'test@example.invalid']);
		git(dir, ['config', 'user.name', 'dreamteamer test']);
	}
	git(dir, ['add', '-A']);
	git(dir, ['commit', '-qm', msg, '--allow-empty']);
}
const write = (dir, files) => { for (const [rel, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), body); } };
const person = (name) => `---\nname: ${name}\n---\n`;
const task = (name, fields = {}) => `---\nname: ${name}\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n`;

/** The shapes every workspace here reads: a bundle clone `org`. */
function shapes(root) {
	const org = path.join(root, 'git_modules', 'org');
	write(org, {
		'package.json': JSON.stringify({ name: 'org', version: '1.0.0', dreamteamer: {} }),
		'collections/people.collection.yaml': PEOPLE, 'collections/projects.collection.yaml': PROJECTS,
		'collections/tasks.collection.yaml': TASKS, 'collections/pics.collection.yaml': PICS, 'collections/briefs.collection.yaml': BRIEFS,
	});
	commitAll(org, 'org');
}

/** A workspace clone at `<root>/git_modules/<key>` named `pkg`, holding `files`. */
function clone(root, key, { pkg = key, files = {} } = {}) {
	const dir = path.join(root, 'git_modules', key);
	write(dir, {
		'package.json': JSON.stringify({ name: pkg, private: true, dreamteamer: { workspace_module: 'default', data_path: 'data', git_modules: {} } }, null, '\t'),
		'modules/default/package.json': JSON.stringify({ name: 'default', dreamteamer: {} }),
		...files,
	});
	commitAll(dir, key);
	return dir;
}

/** A workspace named `pkg` holding `files`, reading `layers` ({ key: { pkg, files, records } }). */
function ws({ pkg = 'w-pkg', files = {}, layers = {} } = {}) {
	const w = workspace({ compile: false });
	shapes(w.root);
	const entries = { org: { url: 'x', ref: 'main' } };
	for (const [key, l] of Object.entries(layers)) {
		clone(w.root, key, l);
		entries[key] = { url: 'x', ref: 'main', ...(l.records ? { records: l.records } : {}) };
	}
	const pkgPath = path.join(w.root, 'package.json');
	const manifest = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	manifest.name = pkg;
	manifest.dreamteamer.git_modules = entries;
	fs.writeFileSync(pkgPath, JSON.stringify(manifest, null, '\t') + '\n');
	write(w.root, files);
	commitAll(w.root, 'ws');
	w.ws.pkg = manifest;
	compileQuietly(w.ws);
	return w;
}

/** R reading `w` as layer `w` (its committed records and manifest, never its layers). */
function readerOf(w, { pkg = 'r-pkg', files = {}, records } = {}) {
	const r = ws({ pkg, files, layers: {} });
	copyInto(r, w, records);
	return r;
}
function copyInto(r, w, records) {
	const dir = path.join(r.root, 'git_modules', 'w');
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	fs.cpSync(path.join(w.root, 'package.json'), path.join(dir, 'package.json'));
	fs.cpSync(path.join(w.root, 'data'), path.join(dir, 'data'), { recursive: true });
	if (fs.existsSync(path.join(w.root, MANIFEST))) fs.cpSync(path.join(w.root, MANIFEST), path.join(dir, MANIFEST));
	fs.mkdirSync(path.join(dir, 'modules', 'default'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'modules', 'default', 'package.json'), JSON.stringify({ name: 'default', dreamteamer: {} }));
	commitAll(dir, 'w');
	const pkgPath = path.join(r.root, 'package.json');
	const manifest = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	manifest.dreamteamer.git_modules.w = { url: 'x', ref: 'main', ...(records ? { records } : {}) };
	fs.writeFileSync(pkgPath, JSON.stringify(manifest, null, '\t') + '\n');
	r.ws.pkg = manifest;
	compileQuietly(r.ws);
}
const manifestOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')).references;
// a manifest as `dt exports` (or the migration) would have written it
const handManifest = (dir, refs) => fs.writeFileSync(path.join(dir, MANIFEST), serializeExports(refs));

/** W reads layer L (package `l-pkg`), which holds people/eli; W's task names it. */
const withLayer = (extra = {}) => ws({
	files: { 'data/tasks/t1.task.md': task('t1', { assignee: 'people/eli' }), ...(extra.files ?? {}) },
	layers: { l: { pkg: 'l-pkg', files: { 'data/people/eli.person.md': person('Eli'), ...(extra.layerFiles ?? {}) } } },
});

describe('external references (cr-dt-004)', () => {
	// T2 (rnd/tests/dreamteamer/cr-dt-004-t2)
	test('a reference no root answers is external when the referring repo\'s manifest lists it; dangling without', () => {
		const w = ws({ files: { 'data/tasks/t1.task.md': task('t1', { assignee: 'people/dana' }) } });
		const bare = dt(w.root, 'check');
		assert.equal(bare.code, 1, bare.stdout);
		assert.match(bare.stdout, /dangling reference "people\/dana"/);
		handManifest(w.root, { people: { dana: { label: 'Dana', from: 'hq-pkg' } } });
		const res = dt(w.root, 'check');
		assert.equal(res.code, 0, res.stdout);
		assert.match(res.stdout, /^ℹ 1 reference to 1 record outside this workspace, vouched for by its exports manifest \(people\/dana\)$/m);
		assert.doesNotMatch(res.stdout, /dangling/);
	});

	// T3 (rnd/tests/dreamteamer/cr-dt-004-t2)
	test('a reader resolves a layer\'s reference through that layer\'s manifest — never the layer\'s layers', () => {
		const w = withLayer({ files: { 'data/tasks/t2.task.md': task('t2', { assignee: 'people/zed' }) } });
		handManifest(path.join(w.root, 'git_modules', 'l'), { people: { zed: { label: 'Zed', from: 'far' } } }); // L's own: never read by R
		fs.rmSync(path.join(w.root, 'data/tasks/t2.task.md'));
		const r0 = readerOf(w);
		const before = dt(r0.root, 'check');
		assert.equal(before.code, 1, before.stdout);
		assert.match(before.stdout, /✖ layer w/);
		assert.match(before.stdout, /dangling reference "people\/eli"/);
		assert.equal(dt(w.root, 'exports').code, 0);
		copyInto(r0, w);
		const after = dt(r0.root, 'check');
		assert.equal(after.code, 0, after.stdout);
		assert.match(after.stdout, /^ℹ layer w: 1 reference to 1 record outside it, vouched for by its exports manifest \(people\/eli\)$/m);
		write(w.root, { 'data/tasks/t2.task.md': task('t2', { assignee: 'people/zed' }) });
		copyInto(r0, w);
		const transitive = dt(r0.root, 'check');
		assert.equal(transitive.code, 1);
		assert.match(transitive.stdout, /dangling reference "people\/zed"/, 'L\'s manifest is never consulted by R');
	});

	// T4 (rnd/tests/dreamteamer/cr-dt-004-t3)
	test('an unlisted layer-only reference warns naming dt exports; --strict-export fails on it until dt exports lists it', () => {
		const w = withLayer();
		const warn = dt(w.root, 'check');
		assert.equal(warn.code, 0, warn.stdout);
		assert.match(warn.stdout, /^⚠ people\/eli resolves only through layer l — named by 1 record here \(tasks\/t1\); a workspace reading this one sees it dangle\. dt exports$/m);
		const strict = dt(w.root, 'check', '--strict-export');
		assert.equal(strict.code, 1, strict.stdout);
		assert.match(strict.stdout, /✖ data\/tasks\/t1\.task\.md\n\s+assignee: "people\/eli" resolves only through layer l — .*dt exports/);
		assert.equal(dt(w.root, 'exports').code, 0);
		const after = dt(w.root, 'check', '--strict-export');
		assert.equal(after.code, 0, after.stdout);
		assert.doesNotMatch(after.stdout, /people\/eli/);
	});

	// T10 (rnd/tests/dreamteamer/cr-dt-004-t2)
	test('a binary target is an ordinary entry, labelled by its id', () => {
		const w = ws({ files: { 'data/tasks/t1.task.md': task('t1', { pic: 'pics/p1' }) }, layers: { l: { pkg: 'l-pkg', files: { 'data/pics/p1.pic.png': 'not really a png' } } } });
		assert.equal(dt(w.root, 'exports').code, 0);
		assert.deepEqual(manifestOf(w.root), { pics: { p1: { label: 'p1', from: 'l-pkg' } } });
		const r = readerOf(w);
		assert.equal(dt(r.root, 'check').code, 0);
	});

	// T14 (rnd/tests/dreamteamer/cr-dt-004-t2)
	test('a holder read only for OTHER collections is not seen for this one: the reference stays external', () => {
		const w = ws({ files: { 'data/tasks/t1.task.md': task('t1', { assignee: 'people/dana' }) } });
		handManifest(w.root, { people: { dana: { label: 'Dana', from: 'h-pkg' } } });
		const r = ws({ pkg: 'r-pkg', layers: { h: { pkg: 'h-pkg', records: ['projects'], files: { 'data/projects/x.project.md': '---\nname: X\n---\n' } } } });
		copyInto(r, w);
		const res = dt(r.root, 'check');
		assert.equal(res.code, 0, res.stdout);
		assert.match(res.stdout, /ℹ layer w: 1 reference/);
		assert.doesNotMatch(res.stdout, /stale/);
	});
});

describe('dt exports (cr-dt-004)', () => {
	// T5 (rnd/tests/dreamteamer/cr-dt-004-t4, -t9)
	test('writes exactly the outside ids with label and holder, byte-stable, committed alone', () => {
		const w = withLayer({ files: { 'data/tasks/t2.task.md': task('t2', { assignee: 'people/mine' }), 'data/people/mine.person.md': person('Mine') } });
		write(w.root, { 'data/tasks/dirty.task.md': task('dirty') });
		fs.appendFileSync(path.join(w.root, 'package.json'), '\n');
		write(w.root, { 'staged.txt': 'staged by another session\n' });
		git(w.root, ['add', 'staged.txt']);
		const head = git(w.root, ['rev-parse', 'HEAD']).trim();
		const res = dt(w.root, 'exports');
		assert.equal(res.code, 0, res.stderr);
		assert.deepEqual(manifestOf(w.root), { people: { eli: { label: 'Eli', from: 'l-pkg' } } }, 'only the outside id; never an id the repo holds');
		assert.equal(readFile(w.root, MANIFEST), '{\n\t"dreamteamer_exports": 1,\n\t"references": {\n\t\t"people": {\n\t\t\t"eli": { "label": "Eli", "from": "l-pkg" }\n\t\t}\n\t}\n}\n');
		assert.deepEqual(git(w.root, ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n'), [MANIFEST]);
		assert.equal(git(w.root, ['rev-parse', 'HEAD~1']).trim(), head);
		const status = git(w.root, ['status', '--porcelain']);
		assert.match(status, /^A  staged\.txt$/m, 'another session\'s staged path stays staged');
		assert.match(status, /^ ?M package\.json$/m);
		assert.match(status, /^\?\? data\/tasks\/dirty\.task\.md$/m);
		const again = dt(w.root, 'exports');
		assert.equal(again.code, 0);
		assert.match(again.stdout, /exports manifest current/);
		assert.equal(git(w.root, ['rev-parse', 'HEAD~1']).trim(), head, 'no second commit');
	});

	// T5b (rnd/tests/dreamteamer/cr-dt-004-t4)
	test('an emptied manifest is deleted in a commit; an unparseable one is a violation and is never overwritten; a pull is judged at once', () => {
		const w = withLayer();
		assert.equal(dt(w.root, 'exports').code, 0);
		fs.rmSync(path.join(w.root, 'data/tasks/t1.task.md'));
		git(w.root, ['commit', '-qam', 'drop t1']);
		assert.equal(dt(w.root, 'exports').code, 0);
		assert.equal(fs.existsSync(path.join(w.root, MANIFEST)), false);
		assert.match(git(w.root, ['show', '--name-status', '--format=', 'HEAD']), /^D\tdreamteamer-exports\.json$/m);
		fs.writeFileSync(path.join(w.root, MANIFEST), '{ <<<<<<< ours');
		const check = dt(w.root, 'check');
		assert.equal(check.code, 1);
		assert.match(check.stdout, /✖ dreamteamer-exports\.json\n\s+dreamteamer-exports\.json does not parse/);
		const refused = dt(w.root, 'exports');
		assert.notEqual(refused.code, 0);
		assert.equal(readFile(w.root, MANIFEST), '{ <<<<<<< ours');
		// a pulled manifest is read from disk on the next check — no compile in between
		handManifest(w.root, { people: { dana: { label: 'Dana', from: 'far' } } });
		write(w.root, { 'data/tasks/t3.task.md': task('t3', { assignee: 'people/dana' }) });
		assert.equal(dt(w.root, 'check').code, 0);
	});

	// T6 (rnd/tests/dreamteamer/cr-dt-004-t4)
	test('stale: a retitled holder record, an unreferenced entry and an entry for an id now held are named; dt exports clears each', () => {
		const w = withLayer();
		assert.equal(dt(w.root, 'exports').code, 0);
		write(path.join(w.root, 'git_modules', 'l'), { 'data/people/eli.person.md': person('Eli Renamed') });
		const res = dt(w.root, 'check');
		assert.equal(res.code, 0, res.stdout);
		assert.match(res.stdout, /^⚠ dreamteamer-exports\.json is stale — people\/eli \(refresh: label "Eli" is now "Eli Renamed"\)\. dt exports$/m);
		assert.equal(dt(w.root, 'check', '--strict-export').code, 1);
		assert.equal(dt(w.root, 'exports').code, 0);
		assert.equal(dt(w.root, 'check', '--strict-export').code, 0);
		handManifest(w.root, { ...manifestOf(w.root), people: { ...manifestOf(w.root).people, idle: { label: 'Idle', from: 'far' } }, projects: { own: { label: 'Own' } } });
		write(w.root, { 'data/projects/own.project.md': '---\nname: Own\n---\n' });
		const stale = dt(w.root, 'check');
		assert.match(stale.stdout, /people\/idle \(drop: no record references it\)/);
		assert.match(stale.stdout, /projects\/own \(drop: held by the repo itself\)/);
		assert.equal(dt(w.root, 'exports').code, 0);
		assert.deepEqual(Object.keys(manifestOf(w.root)), ['people']);
		assert.deepEqual(Object.keys(manifestOf(w.root).people), ['eli']);
	});

	// T7 + T16 (rnd/tests/dreamteamer/cr-dt-004-t8)
	test('a holder the checker reads that lost the id makes the reference dangling and the manifest stale; dt exports --layer drops it', () => {
		const w = ws({ files: { 'data/tasks/t1.task.md': task('t1', { assignee: 'people/ann' }) } });
		const r = ws({ pkg: 'r-pkg', files: { 'data/people/ann.person.md': person('Ann') } });
		copyInto(r, w);
		assert.equal(dt(r.root, 'exports', '--layer', 'w').code, 0);
		assert.deepEqual(manifestOf(path.join(r.root, 'git_modules', 'w')), { people: { ann: { label: 'Ann', from: 'r-pkg' } } });
		const rm = dt(r.root, 'rm', 'people/ann', '--force');
		assert.equal(rm.code, 0, rm.stderr);
		const res = dt(r.root, 'check');
		assert.equal(res.code, 1, res.stdout);
		assert.match(res.stdout, /dangling reference "people\/ann" — no such record \(its holder r-pkg is read here and does not have it\)/);
		assert.match(res.stdout, /^⚠ git_modules\/w\/dreamteamer-exports\.json is stale — people\/ann \(drop: its holder r-pkg no longer has it\)\. dt exports --layer w$/m);
		assert.equal(dt(r.root, 'exports', '--layer', 'w').code, 0);
		assert.equal(fs.existsSync(path.join(r.root, 'git_modules', 'w', MANIFEST)), false);
	});

	test('holder identity is the package name, not the git_modules key; an absent holder clone vouches', () => {
		const w = ws({ files: { 'data/tasks/t1.task.md': task('t1', { assignee: 'people/eli' }) }, layers: { people: { pkg: '@acme/people', files: { 'data/people/eli.person.md': person('Eli') } } } });
		assert.equal(dt(w.root, 'exports').code, 0);
		assert.deepEqual(manifestOf(w.root), { people: { eli: { label: 'Eli', from: '@acme/people' } } });
		fs.rmSync(path.join(w.root, 'git_modules', 'people', 'data', 'people', 'eli.person.md'));
		const lost = dt(w.root, 'check');
		assert.equal(lost.code, 1, lost.stdout);
		assert.match(lost.stdout, /its holder @acme\/people is read here and does not have it/);
		fs.rmSync(path.join(w.root, 'git_modules', 'people'), { recursive: true, force: true });
		const gone = dt(w.root, 'check');
		assert.equal(gone.code, 0, gone.stdout);
		assert.match(gone.stdout, /ℹ 1 reference to 1 record outside this workspace/);
	});

	// T13 + T13b (rnd/tests/dreamteamer/cr-dt-004-t2, -t4)
	test('a holder-less entry is kept by a context that cannot resolve it, and filled by the first that can', () => {
		const w = ws({ files: { 'data/tasks/t1.task.md': task('t1', { assignee: 'people/dana' }) } });
		handManifest(w.root, { people: { dana: { label: 'From a stub' } } });
		git(w.root, ['add', MANIFEST]); git(w.root, ['commit', '-qm', 'migrated']);
		const bytes = readFile(w.root, MANIFEST);
		assert.equal(dt(w.root, 'exports').code, 0);
		assert.equal(readFile(w.root, MANIFEST), bytes, 'W cannot resolve it: kept as written');
		const far = readerOf(w);
		assert.equal(dt(far.root, 'exports', '--layer', 'w').code, 0);
		assert.equal(readFile(far.root, `git_modules/w/${MANIFEST}`), bytes, 'a reader that does not hold it keeps it too');
		assert.doesNotMatch(dt(far.root, 'check').stdout, /stale/);
		const holder = readerOf(w, { files: { 'data/people/dana.person.md': person('Dana') } });
		assert.match(dt(holder.root, 'check').stdout, /people\/dana \(fill: held by r-pkg\)/);
		assert.equal(dt(holder.root, 'exports', '--layer', 'w').code, 0);
		assert.deepEqual(manifestOf(path.join(holder.root, 'git_modules', 'w')), { people: { dana: { label: 'Dana', from: 'r-pkg' } } });
		assert.match(dt(holder.root, 'exports', '--layer', 'w').stdout, /exports manifest current/);
	});

	// T15 (rnd/tests/dreamteamer/cr-dt-004-t4)
	test('two holders of one id: each context keeps the other\'s entry — a fixpoint, never stale', () => {
		const w = withLayer();
		assert.equal(dt(w.root, 'exports').code, 0);
		const r = readerOf(w, { files: { 'data/people/eli.person.md': person('Eli Elsewhere') } });
		const before = readFile(r.root, `git_modules/w/${MANIFEST}`);
		const out = dt(r.root, 'exports', '--layer', 'w');
		assert.match(out.stdout, /exports manifest current/);
		assert.equal(readFile(r.root, `git_modules/w/${MANIFEST}`), before);
		assert.doesNotMatch(dt(r.root, 'check').stdout, /stale/);
		assert.match(dt(w.root, 'exports').stdout, /exports manifest current/);
	});

	// T17 (rnd/tests/dreamteamer/cr-dt-004-t4)
	test('a reader never names a layer stale for entries it could merely add, and writes nothing unasked', () => {
		const w = ws({ files: { 'data/tasks/t1.task.md': task('t1', { assignee: 'people/ann' }) } });
		const r = ws({ pkg: 'r-pkg', files: { 'data/people/ann.person.md': person('Ann') } });
		copyInto(r, w);
		const res = dt(r.root, 'check');
		assert.equal(res.code, 0, res.stdout);
		assert.doesNotMatch(res.stdout, /stale|exports/);
		assert.equal(fs.existsSync(path.join(r.root, 'git_modules', 'w', MANIFEST)), false);
		const alone = dt(w.root, 'check');
		assert.equal(alone.code, 1);
		assert.match(alone.stdout, /dangling reference "people\/ann"/);
	});

	// T18 (rnd/tests/dreamteamer/cr-dt-004-t4)
	test('referrer visibility: a reader that reads only some of a layer\'s collections never drops an entry as unreferenced', () => {
		const w = ws({ files: { 'data/tasks/t1.task.md': task('t1', { assignee: 'people/x' }), 'data/projects/p.project.md': '---\nname: P\n---\n' } });
		handManifest(w.root, { people: { x: { label: 'X', from: 'far' } } });
		const r = readerOf(w, { records: ['projects'] });
		assert.doesNotMatch(dt(r.root, 'check').stdout, /stale/);
		assert.match(dt(r.root, 'exports', '--layer', 'w').stdout, /exports manifest current/);
		assert.equal(dt(w.root, 'check').code, 0);
		const whole = readerOf(w);
		fs.rmSync(path.join(whole.root, 'git_modules', 'w', 'data', 'tasks', 't1.task.md'));
		assert.match(dt(whole.root, 'check').stdout, /people\/x \(drop: no record references it\)/);
	});

	// T19 (rnd/tests/dreamteamer/cr-dt-004-t4)
	test('a collection compiled-skipped for the layer, or a folder appearing after compile, makes it incomplete: nothing dropped', () => {
		const w = ws({ files: { 'data/briefs/b1.brief.md': '---\nname: B1\nlead: people/x\n---\n', 'data/projects/p.project.md': '---\nname: P\n---\n' } });
		handManifest(w.root, { people: { x: { label: 'X', from: 'far' } } });
		const r = readerOf(w);
		assert.doesNotMatch(dt(r.root, 'check').stdout, /stale/, 'briefs is module-owned: never read from w');
		const r2 = readerOf(ws({ files: { 'data/projects/p.project.md': '---\nname: P\n---\n' } }));
		handManifest(path.join(r2.root, 'git_modules', 'w'), { people: { x: { label: 'X', from: 'far' } } });
		write(path.join(r2.root, 'git_modules', 'w'), { 'data/unknown/u1.thing.md': '---\nname: U\n---\n' });
		assert.doesNotMatch(dt(r2.root, 'check').stdout, /people\/x \(drop/, 'a folder pulled after compile: incomplete, no recompile needed');
	});

	// T20 (rnd/tests/dreamteamer/cr-dt-004-t4)
	test('holder names come from the runtime: check opens no layer package.json', () => {
		const w = ws({ files: { 'data/tasks/t1.task.md': task('t1', { assignee: 'people/eli' }) }, layers: { people: { pkg: '@acme/people', files: { 'data/people/eli.person.md': person('Eli') } } } });
		assert.equal(dt(w.root, 'exports').code, 0);
		const pj = path.join(w.root, 'git_modules', 'people', 'package.json');
		fs.chmodSync(pj, 0o000);
		try {
			fs.rmSync(path.join(w.root, 'git_modules', 'people', 'data', 'people', 'eli.person.md'));
			assert.match(dt(w.root, 'check').stdout, /its holder @acme\/people is read here and does not have it/);
		} finally { fs.chmodSync(pj, 0o644); }
	});

	test('during a merge in a linked worktree the manifest is written and not committed', () => {
		const w = withLayer();
		git(w.root, ['branch', 'side']);
		const wt = path.join(path.dirname(w.root), `${path.basename(w.root)}-wt`);
		git(w.root, ['worktree', 'add', '-q', wt, 'side']);
		try {
			fs.cpSync(path.join(w.root, 'git_modules'), path.join(wt, 'git_modules'), { recursive: true });
			fs.symlinkSync(path.join(w.root, 'node_modules'), path.join(wt, 'node_modules'));
			fs.writeFileSync(path.join(wt, 'side.txt'), 'side\n');
			git(wt, ['add', 'side.txt']); git(wt, ['commit', '-qm', 'side']);
			write(w.root, { 'main.txt': 'main\n' }); git(w.root, ['add', 'main.txt']); git(w.root, ['commit', '-qm', 'main']);
			git(wt, ['merge', '--no-commit', '--no-ff', '-q', 'main']);
			compileQuietly({ root: wt, pkg: w.ws.pkg });
			const head = git(wt, ['rev-parse', 'HEAD']).trim();
			const res = dt(wt, 'exports');
			assert.equal(res.code, 0, res.stderr);
			assert.match(res.stdout, /a merge is in progress — the manifest is written; git add it and conclude it/);
			assert.ok(fs.existsSync(path.join(wt, MANIFEST)));
			assert.equal(git(wt, ['rev-parse', 'HEAD']).trim(), head);
		} finally { git(w.root, ['worktree', 'remove', '--force', wt]); }
	});

	test('consistency: check names a manifest stale exactly when dt exports --dry-run reports a non-add change', () => {
		const w = withLayer();
		const kinds = () => JSON.parse(dt(w.root, 'exports', '--dry-run', '--json').stdout).manifests[0].changes.map((c) => c.kind);
		const stale = () => /is stale/.test(dt(w.root, 'check').stdout);
		const states = [
			() => {},
			() => dt(w.root, 'exports'),
			() => write(path.join(w.root, 'git_modules', 'l'), { 'data/people/eli.person.md': person('Eli 2') }),
			() => handManifest(w.root, { people: { eli: { label: 'Eli 2', from: 'l-pkg' }, gone: { label: 'G', from: 'far' } } }),
			() => handManifest(w.root, { people: { eli: { label: 'Eli 2' } } }),
		];
		for (const s of states) { s(); assert.equal(stale(), kinds().some((k) => k !== 'add')); }
	});
});

describe('dt get on an external id (cr-dt-004)', () => {
	// T9 (rnd/tests/dreamteamer/cr-dt-004-t7)
	test('exits 1 naming label and holder; --json carries $external; Store.external answers the same, with a referrer from a layer', () => {
		const w = ws({ files: { 'data/tasks/t1.task.md': task('t1', { assignee: 'people/dana' }) } });
		handManifest(w.root, { people: { dana: { label: 'Dana', from: 'hq-pkg' } } });
		const res = dt(w.root, 'get', 'people/dana');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /people\/dana is not held here — external: "Dana", held by hq-pkg \(dreamteamer-exports\.json\)/);
		const json = dt(w.root, 'get', 'people/dana', '--json');
		assert.equal(json.code, 1);
		assert.deepEqual(JSON.parse(json.stdout).$external, { collection: 'people', id: 'dana', label: 'Dana', from: 'hq-pkg', manifest: MANIFEST });
		assert.equal(dt(w.root, 'get', 'people/nobody').code, 1);

		const r = readerOf(w);
		const store = new Store(r.ws);
		assert.equal(store.external('people', 'dana'), null, 'R\'s own manifest does not list it');
		assert.deepEqual(store.external('people', 'dana', { referrer: 'tasks/t1' }), { label: 'Dana', from: 'hq-pkg', manifest: `git_modules/w/${MANIFEST}` });
		const viaGet = dt(r.root, 'get', 'people/dana', '--referrer', 'tasks/t1');
		assert.equal(viaGet.code, 1);
		assert.match(viaGet.stderr, /held by hq-pkg \(git_modules\/w\/dreamteamer-exports\.json\)/);
		assert.throws(() => store.external('people', 'dana', { referrer: 'tasks/none' }), /tasks\/none: no such record here/);
		const holder = readerOf(w, { pkg: 'hq-pkg', files: { 'data/people/dana.person.md': person('Dana') } });
		assert.equal(new Store(holder.ws).external('people', 'dana', { referrer: 'tasks/t1' }), null, 'held here: live wins');
	});
});
