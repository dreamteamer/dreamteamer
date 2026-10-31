// `--workspace <name-or-path>` / `-w` — the one flag that runs a verb in another workspace (0.41.0).
//
// A record layer is another workspace cloned under git_modules/, and every surface names it by its
// manifest name (`dt status`, `check`'s `layer <name>`, `$repo`). Adding a record INTO it used to need
// `--vault git_modules/<clone>`, a path typed nowhere else — and that path resolved to the OUTER
// workspace, because workspace discovery climbs out of a module folder. So the write landed in the
// reader and printed ✔. Pinned here: a declared layer NAME resolves, a path still resolves (and lands
// in the clone, not around it), an undeclared name is refused with the declared list, and `--vault`
// is still honoured as an alias.
//
// ⚠ Each assertion is about where the record LANDED, never that the flag parsed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { workspace, simpleCollection, compileQuietly, dt, dtIn, git, ENGINE_ROOT } from '../helpers/ws.js';

/** An HQ workspace and one project WORKSPACE cloned under its git_modules/ — a full, compiled workspace
 *  of its own (its manifest names `workspace_module`, so the HQ reads it as a layer). Both carry `widgets`. */
function hqWithLayer() {
	const widgets = simpleCollection({ storage: { suffix: 'widget' } });
	const hq = workspace({ collections: { widgets } });
	const proj = workspace({ collections: { widgets } });
	const clone = path.join(hq.root, 'git_modules', 'project-a');
	fs.mkdirSync(path.dirname(clone), { recursive: true });
	fs.cpSync(proj.root, clone, { recursive: true, dereference: false, verbatimSymlinks: true });
	const lpkg = JSON.parse(fs.readFileSync(path.join(clone, 'package.json'), 'utf8'));
	lpkg.name = 'project-a';
	fs.writeFileSync(path.join(clone, 'package.json'), JSON.stringify(lpkg, null, '\t') + '\n');
	git(clone, ['add', 'package.json']); git(clone, ['commit', '-qm', 'name']);
	compileQuietly({ root: clone, pkg: lpkg });
	const pkgPath = path.join(hq.root, 'package.json');
	const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	pkg.dreamteamer.git_modules = { 'project-a': { url: 'x', ref: 'main' } };
	fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');
	hq.ws.pkg = pkg;
	compileQuietly(hq.ws);
	return { hq, clone };
}

const inLayer = (clone) => path.join(clone, 'data', 'widgets', 'gearbox.widget.md');
const inHq = (hq) => path.join(hq.root, 'data', 'widgets', 'gearbox.widget.md');

describe('-w / --workspace targets a declared layer by NAME or a workspace by PATH', () => {
	test('a declared layer name resolves to git_modules/<name>: the record lands in the layer, says so, and the HQ reads it through the layer', () => {
		const { hq, clone } = hqWithLayer();
		const res = dt(hq.root, 'add', 'widgets', '--name', 'Gearbox', '-w', 'project-a');
		assert.equal(res.code, 0, res.stderr);
		assert.ok(fs.existsSync(inLayer(clone)), 'the record is in the layer clone');
		assert.ok(!fs.existsSync(inHq(hq)), 'and not in the HQ');
		assert.match(res.stdout, /✔ project-a · data\/widgets\/gearbox\.widget\.md/);
		const got = JSON.parse(dt(hq.root, 'get', 'widgets/gearbox', '--json').stdout);
		assert.equal(got.$repo, 'git_modules/project-a');
	});

	test('--workspace is the same flag, and the verb after it runs in the layer (list)', () => {
		const { hq, clone } = hqWithLayer();
		assert.equal(dt(hq.root, '--workspace', 'project-a', 'add', 'widgets', '--name', 'Gearbox').code, 0);
		assert.ok(fs.existsSync(inLayer(clone)));
		assert.equal(dt(hq.root, 'add', 'widgets', '--name', 'Flywheel').code, 0, 'the flag does not outlive its command');
		assert.equal(dt(hq.root, 'list', 'widgets', '-w', 'project-a').stdout.trim(), 'gearbox', "the layer's own listing, not the union");
	});

	test('a PATH still resolves — and a path INTO git_modules/ lands in the clone, not in the workspace around it', () => {
		const { hq, clone } = hqWithLayer();
		const res = dt(hq.root, 'add', 'widgets', '--name', 'Gearbox', '-w', 'git_modules/project-a');
		assert.equal(res.code, 0, res.stderr);
		assert.ok(fs.existsSync(inLayer(clone)), 'in the clone');
		assert.ok(!fs.existsSync(inHq(hq)), 'never in the outer workspace');
		const other = workspace({ collections: { widgets: simpleCollection({ storage: { suffix: 'widget' } }) } });
		assert.equal(dt(hq.root, '-w', other.root, 'add', 'widgets', '--name', 'Gearbox').code, 0);
		assert.ok(fs.existsSync(path.join(other.root, 'data', 'widgets', 'gearbox.widget.md')));
	});

	test('an undeclared name is refused, listing the declared layers; a bare flag is refused', () => {
		const { hq } = hqWithLayer();
		const res = dt(hq.root, 'add', 'widgets', '--name', 'Gearbox', '-w', 'project-z');
		assert.notEqual(res.code, 0);
		assert.match(res.stderr, /--workspace project-z — no such directory, and no layer of that name is declared here \(declared layers: project-a\)/);
		assert.ok(!fs.existsSync(inHq(hq)), 'nothing was written');
		const bare = dt(hq.root, 'list', 'widgets', '-w');
		assert.notEqual(bare.code, 0);
		assert.match(bare.stderr, /--workspace needs a layer name or a path/);
	});

	test('--vault still works as a silent alias, including into a layer clone', () => {
		const { hq, clone } = hqWithLayer();
		const res = dtIn(hq.root, '--vault', 'git_modules/project-a', 'add', 'widgets', '--name', 'Gearbox');
		assert.equal(res.code, 0, res.stderr);
		assert.ok(fs.existsSync(inLayer(clone)));
		assert.doesNotMatch(res.stderr, /deprecated/, 'silent');
	});

	test('dt help documents --workspace / -w and marks --vault deprecated', () => {
		const out = dt(path.dirname(path.dirname(hqWithLayer().hq.root)), 'help').stdout;
		assert.match(out, /--workspace, -w <name\|path>/);
		assert.match(out, /--vault <path>\s+deprecated/);
	});

	test('a target that is not a workspace root is refused: a plain folder named like the layer, or a declared BUNDLE; the unknown-name list names layers only', () => {
		const { hq, clone } = hqWithLayer();
		// a plain folder in the cwd that happens to carry the layer's name
		fs.mkdirSync(path.join(hq.root, 'sub', 'project-a'), { recursive: true });
		const plain = dtIn(path.join(hq.root, 'sub'), 'add', 'widgets', '--name', 'Gearbox', '-w', 'project-a');
		assert.notEqual(plain.code, 0);
		assert.match(plain.stderr, /--workspace project-a — .*sub\/project-a is not a workspace \(no package\.json with a "dreamteamer" section\)/);
		assert.ok(!fs.existsSync(inHq(hq)) && !fs.existsSync(inLayer(clone)), 'nothing was written anywhere');
		// a declared bundle: a clone whose manifest names no workspace_module
		const bun = path.join(hq.root, 'git_modules', 'kit');
		fs.mkdirSync(bun, { recursive: true });
		fs.writeFileSync(path.join(bun, 'package.json'), JSON.stringify({ name: 'kit', dreamteamer: {} }));
		const pkgPath = path.join(hq.root, 'package.json');
		const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
		pkg.dreamteamer.git_modules.kit = { url: 'x', ref: 'main' };
		fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');
		const bundled = dt(hq.root, 'add', 'widgets', '--name', 'Gearbox', '-w', 'kit');
		assert.notEqual(bundled.code, 0);
		assert.match(bundled.stderr, /--workspace kit — git_modules\/kit is a bundle \(its package\.json names no workspace_module\), not a workspace/);
		assert.ok(!fs.existsSync(inHq(hq)));
		assert.match(dt(hq.root, 'list', 'widgets', '-w', 'nope').stderr, /\(declared layers: project-a\)/);
	});

	test('the -w pin never reaches another process: inside a layer clone, dt answers the reader\'s union whatever the environment holds', () => {
		const { hq, clone } = hqWithLayer();
		assert.equal(dt(hq.root, 'add', 'widgets', '--name', 'Gearbox', '-w', 'project-a').code, 0);
		assert.equal(dt(hq.root, 'add', 'widgets', '--name', 'Flywheel').code, 0);
		const inClone = (env) => spawnSync(process.execPath, [path.join(ENGINE_ROOT, 'bin', 'dreamteamer.js'), 'list', 'widgets'], { cwd: path.join(clone, 'data'), env: { ...process.env, ...env }, encoding: 'utf8' }).stdout.trim().split('\n').sort();
		assert.deepEqual(inClone({}), ['flywheel', 'gearbox'], "a bare dt inside the clone is the reader's union");
		assert.deepEqual(inClone({ DREAMTEAMER_WORKSPACE: fs.realpathSync(clone) }), ['flywheel', 'gearbox'], 'an inherited or hand-set variable changes nothing');
	});

	test('--workspace=<x> is honoured exactly like --workspace <x>', () => {
		const { hq, clone } = hqWithLayer();
		const res = dt(hq.root, 'add', 'widgets', '--name', 'Gearbox', '--workspace=project-a');
		assert.equal(res.code, 0, res.stderr);
		assert.ok(fs.existsSync(inLayer(clone)));
	});
});
