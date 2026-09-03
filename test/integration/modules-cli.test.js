// Tier 2 — MODULE CRUD through the real binary. A module was the one system entity with no verbs at
// all: no add, no rm, no rename, and no way to name one as a target. Creating a second inline module
// took six manual steps (measured 2026-09-01), and the only working workaround for the last of them
// was a mode switch.
//
// ⚠ The grammar needs no cli.js change. `add` is already a COLLECTION_VERB and `set`/`rm`/`rename`
// are already REF_VERBS, so `dt add modules --name core` and `dt rm modules/core` already reach
// `collectionCommand(ws, 'modules', <verb>, …)` — which today falls through to the generic record
// switch and is refused by the store ("records are compiled sources"). Intercepting at the top of
// that function is the whole dispatch, exactly as §4 says.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { twoModuleWorkspace, readFile } from '../helpers/ws.js';
import { load, dump } from '../../src/yaml.js';

const modulePkg = (ws, id) => JSON.parse(readFile(ws.root, `modules/${id}/package.json`));

describe('dt add modules', () => {
	test('scaffolds the folder, every kind dir, and a package.json that compiles', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('add', 'modules', '--name', 'payroll', '--description', 'What people are paid.');
		assert.equal(res.code, 0, res.stdout + res.stderr);

		const pkg = modulePkg(ws, 'payroll');
		assert.equal(pkg.name, 'payroll', 'folder = package name = id, so a new module never forks');
		assert.equal(pkg.dreamteamer.description, 'What people are paid.');
		assert.deepEqual(pkg.files, ['collections', 'skills', 'agents', 'commands', 'command-bindings', 'ui-views', 'collection-templates']);
		for (const kind of pkg.files) {
			assert.ok(fs.existsSync(path.join(ws.root, 'modules/payroll', kind)), `${kind}/ is scaffolded`);
		}
		assert.match(res.stdout, /modules\/payroll/);
		assert.equal(ws.dt('compile').code, 0);
		assert.equal(ws.dt('check').code, 0);
	});

	test('the new module is a record, with its identity spellings visible', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('add', 'modules', '--name', 'payroll').code, 0);
		const rec = JSON.parse(ws.dt('get', 'modules/payroll', '--json').stdout);
		assert.equal(rec.id, 'payroll');
		assert.equal(rec.name, 'payroll');
		assert.equal(rec.location, 'modules');
		assert.equal(rec.path, 'modules/payroll');
	});

	test('a scaffolded-but-empty module does NOT get the "contributed no recognised sources" warning', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('add', 'modules', '--name', 'payroll').code, 0);
		const out = ws.dt('compile');
		assert.equal(out.code, 0, out.stderr);
		assert.doesNotMatch(out.stdout + out.stderr, /contributed no recognised sources/,
			'a module being authored is not a mistake — and warning about the verb\'s own output reads as broken');
	});

	test('a module with NO recognised kind folder still gets the warning', () => {
		const ws = twoModuleWorkspace({ compile: false });
		const mod = path.join(ws.root, 'modules', 'hollow');
		fs.mkdirSync(mod, { recursive: true });
		fs.writeFileSync(path.join(mod, 'package.json'),
			JSON.stringify({ name: 'hollow', private: true, version: '0.0.1', dreamteamer: {} }, null, '\t') + '\n');
		const out = ws.dt('compile');
		assert.equal(out.code, 0, out.stderr);
		assert.match(out.stdout + out.stderr, /module "hollow".*contributed no recognised sources/s);
	});

	test('a duplicate id is refused by name', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('add', 'modules', '--name', 'core');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /module "core" already exists/);
	});

	test('an invalid id is refused before anything is written', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('add', 'modules', '--name', 'Pay Roll');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /invalid module id "Pay Roll"/);
		assert.equal(fs.existsSync(path.join(ws.root, 'modules', 'Pay Roll')), false);
	});
});

describe('dt set modules/<id>', () => {
	test('writes description, dependencies and peerDependencies in record-shaped values', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('set', 'modules/hr', 'description=Roles, headcount and grades.',
			'dependencies=modules/core', 'peerDependencies=collections/people');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		const dt = modulePkg(ws, 'hr').dreamteamer;
		assert.equal(dt.description, 'Roles, headcount and grades.');
		assert.deepEqual(dt.dependencies, ['core'], 'the record form is translated to the package-name form the source uses');
		assert.deepEqual(dt.peerDependencies, ['people'], 'a peer names a COLLECTION, bare');
		const rec = JSON.parse(ws.dt('get', 'modules/hr', '--json').stdout);
		assert.deepEqual(rec.dependencies, ['modules/core']);
	});

	test('an empty value clears the key', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('set', 'modules/hr', 'dependencies=modules/core').code, 0);
		assert.equal(ws.dt('set', 'modules/hr', 'dependencies=').code, 0);
		assert.equal(modulePkg(ws, 'hr').dreamteamer.dependencies, undefined);
	});

	test('an unknown module names the known ones', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('set', 'modules/nope', 'description=x');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /no module "nope"/);
		assert.match(res.stderr, /core/);
		assert.match(res.stderr, /dt list modules/);
	});

	test('an unknown key is refused rather than written into the package', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('set', 'modules/hr', 'colour=blue');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /"colour" is not a settable field of modules/);
	});
});

describe('dt rm modules/<id>', () => {
	test('refuses while the module still ships entities, and counts the ones with records', () => {
		const ws = twoModuleWorkspace();
		ws.dt('add', 'people', '--name', 'Dana Levi');
		const res = ws.dt('rm', 'modules/core');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /core still ships 3 collections \(people, tasks, teams\), 1 with records/);
		assert.match(res.stderr, /--force removes the sources; records stay and become unindexed/);
	});

	test('--dry-run prints the plan WITHOUT --force — the plan is how you decide to type it', () => {
		const ws = twoModuleWorkspace();
		ws.dt('add', 'people', '--name', 'Dana Levi');
		const res = ws.dt('rm', 'modules/core', '--dry-run');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.match(res.stdout, /dry run/);
		assert.match(res.stdout, /records 0 · refs 0 · descriptors 3 · values cleared 0/);
		assert.match(res.stdout, /records left in place and UNINDEXED: people/);
		assert.ok(readFile(ws.root, 'modules/core/package.json'), 'nothing removed');
	});

	test('--force removes the sources and leaves the records alone', () => {
		const ws = twoModuleWorkspace();
		ws.dt('add', 'people', '--name', 'Dana Levi');
		// hr peer-references `people`, which becomes unresolvable — that is the stated trade, and a
		// peer is exactly the declaration that survives it.
		const res = ws.dt('rm', 'modules/core', '--force');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.equal(fs.existsSync(path.join(ws.root, 'modules', 'core')), false);
		assert.ok(readFile(ws.root, 'data/people/dana-levi.person.md'), 'records stay in place');
		assert.equal(ws.dt('compile').code, 0);
	});

	test('an empty module needs no --force', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('add', 'modules', '--name', 'payroll').code, 0);
		const res = ws.dt('rm', 'modules/payroll');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.equal(fs.existsSync(path.join(ws.root, 'modules', 'payroll')), false);
	});

	test('the workspace module itself is refused', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('rm', 'modules/default', '--force');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /IS this workspace's own module/);
	});

	test('an npm-shipped module is refused, naming npm as the remedy', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('rm', 'modules/dreamteamer', '--force');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /installed by npm/);
	});

	test('a dependent module\'s dependencies entry goes in the SAME write', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('set', 'modules/hr', 'dependencies=modules/core').code, 0);
		const res = ws.dt('rm', 'modules/core', '--force');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.equal(modulePkg(ws, 'hr').dreamteamer.dependencies, undefined,
			'left behind, compile would fail with "depends on core, which is not installed"');
		assert.equal(ws.dt('compile').code, 0);
	});
});

describe('dt rename modules/<old> <new>', () => {
	test('rewrites folder, package name, dependencies, extends and record refs in ONE commit', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('set', 'modules/hr', 'dependencies=modules/core').code, 0);
		// an overlay in hr on core's `people`, so the `extends` rewrite has something to do
		fs.mkdirSync(path.join(ws.root, 'modules/hr/collections'), { recursive: true });
		fs.writeFileSync(path.join(ws.root, 'modules/hr/collections/people.collection.yaml'),
			'name: people\nextends: core/people\nschema:\n  properties:\n    badge: { type: string }\n');
		assert.equal(ws.dt('compile').code, 0);
		const before = ws.git(['rev-parse', 'HEAD']);

		const res = ws.dt('rename', 'modules/core', 'shared');
		assert.equal(res.code, 0, res.stdout + res.stderr);

		assert.equal(fs.existsSync(path.join(ws.root, 'modules', 'core')), false);
		assert.equal(modulePkg(ws, 'shared').name, 'shared');
		assert.deepEqual(modulePkg(ws, 'hr').dreamteamer.dependencies, ['shared']);
		assert.equal(load(readFile(ws.root, 'modules/hr/collections/people.collection.yaml')).extends, 'shared/people');
		assert.equal(ws.dt('compile').code, 0);
		assert.equal(ws.dt('check').code, 0);
		assert.equal(ws.git(['rev-list', '--count', `${before}..HEAD`]), '1', 'ONE commit');
	});

	test('a `disable` entry naming the module follows the rename', () => {
		const ws = twoModuleWorkspace();
		const pkgFile = path.join(ws.root, 'package.json');
		const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
		pkg.dreamteamer.disable = ['core/teams'];
		fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, '\t') + '\n');
		assert.equal(ws.dt('compile').code, 0);
		assert.equal(ws.dt('rename', 'modules/core', 'shared').code, 0);
		assert.deepEqual(JSON.parse(fs.readFileSync(pkgFile, 'utf8')).dreamteamer.disable, ['shared/teams']);
		assert.equal(ws.dt('compile').code, 0);
	});

	test('renaming the workspace module moves the workspace-module key with it', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('rename', 'modules/default', 'commons').code, 0);
		const pkg = JSON.parse(readFile(ws.root, 'package.json'));
		assert.equal(pkg.dreamteamer['workspace-module'], 'commons');
		assert.equal(ws.dt('compile').code, 0);
		assert.equal(ws.dt('check').code, 0);
	});

	test('a taken id is refused', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('rename', 'modules/core', 'hr');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /module "hr" already exists/);
	});
});

describe('dt list modules shows all three identity spellings', () => {
	test('id, package name and path are each a column', () => {
		const ws = twoModuleWorkspace();
		const rows = JSON.parse(ws.dt('list', 'modules', '--json').stdout);
		const core = rows.find((r) => r.id === 'core');
		assert.equal(core.name, 'core');
		assert.equal(core.path, 'modules/core');
		const plain = ws.dt('list', 'modules').stdout;
		assert.match(plain, /core\s+modules\s+modules\/core/);
	});
});

describe('location — the folder the operator already knows (§10)', () => {
	test('an inline module reads `modules`, not `inline`', () => {
		const ws = twoModuleWorkspace();
		const rec = JSON.parse(ws.dt('get', 'modules/core', '--json').stdout);
		assert.equal(rec.location, 'modules');
		assert.equal(rec.channel, undefined, 'this is a RENAME — the old key is gone from the record');
	});

	test('an npm module reads `node_modules`', () => {
		const ws = twoModuleWorkspace();
		assert.equal(JSON.parse(ws.dt('get', 'modules/dreamteamer', '--json').stdout).location, 'node_modules');
	});

	test('dt status needs no legend', () => {
		const ws = twoModuleWorkspace();
		const out = ws.dt('status').stdout;
		assert.match(out, /core\s+modules$/m, 'the folder name IS the label — no [inline] to decode');
		assert.match(out, /dreamteamer\s+node_modules$/m);
		assert.doesNotMatch(out, /\[inline\]|\[npm\]|\[git\]/);
	});

	test('the enum has no `path` value — discovery never emitted one', () => {
		const ws = twoModuleWorkspace();
		const d = load(readFile(ws.root, '.dreamteamer/collections/modules.collection.yaml'));
		assert.deepEqual(d.schema.properties.location.enum, ['modules', 'git_modules', 'node_modules', 'root']);
	});

	test('the manifest carries BOTH keys for one release', () => {
		const ws = twoModuleWorkspace();
		const m = load(readFile(ws.root, '.dreamteamer/manifest.yaml'));
		const core = m.modules.find((x) => x.name === 'core');
		assert.equal(core.location, 'modules');
		assert.equal(core.channel, 'inline', 'compat: a reader that has not moved keeps working');
	});

	test('sourceRoots still excludes npm copies, read off either key', () => {
		const ws = twoModuleWorkspace();
		// the ref-surgery path uses sourceRoots; a rename proves it still reaches the right modules
		assert.equal(ws.dt('rename', 'collections/teams', 'squads').code, 0);
		assert.ok(readFile(ws.root, 'modules/core/collections/squads.collection.yaml'));
	});

	test('a manifest written by an OLDER engine (channel only) still resolves sourceRoots', () => {
		const ws = twoModuleWorkspace();
		const file = path.join(ws.root, '.dreamteamer/manifest.yaml');
		const m = load(fs.readFileSync(file, 'utf8'));
		// strip the new key, leaving exactly what 0.18.0 wrote
		m.modules = m.modules.map(({ location, ...rest }) => rest);
		fs.writeFileSync(file, dump(m));
		// a read path that goes through sourceRoots must not see zero modules
		assert.equal(ws.dt('list', 'people').code, 0);
		assert.equal(ws.dt('check').code, 0);
	});
});
