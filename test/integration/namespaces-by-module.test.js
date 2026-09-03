// Tier 2 — NAMESPACES ARE DECLARED BY THE MODULE THAT OWNS THEM (§8, option A).
//
// The rule this reverses — "namespaces are declared by the WORKSPACE only, never by a module" — had
// a real reason: a module that can declare a namespace can rename where another module's records
// live. But it made decision 130's acceptance test ("compiles alone in a bare workspace")
// UNPASSABLE for any namespaced module, because the consuming workspace had to edit its own
// manifest first. The union plus a single-owner rule plus a use-requires-dependency rule keeps the
// protection and passes the gate.
//
// ⚠ The record layer is UNCHANGED by all of this. compile stamps the resolved set into the
// manifest, and `namespace.js`, `parseRef`, the store, `check` and the extension read it from there
// — the same shape `storage.base` has.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { twoModuleWorkspace, bareWorkspace, writeModule, patchModulePkg, readFile } from '../helpers/ws.js';
import { load } from '../../src/yaml.js';

const manifest = (ws) => load(readFile(ws.root, '.dreamteamer/manifest.yaml'));

describe('the effective set is the UNION', () => {
	test('a module\'s own declaration reaches the manifest with no workspace entry at all', () => {
		const ws = twoModuleWorkspace();
		assert.equal(JSON.parse(readFile(ws.root, 'package.json')).dreamteamer.namespaces, undefined,
			'the workspace declares nothing');
		assert.deepEqual(manifest(ws).namespaces, ['hr']);
		assert.equal(ws.dt('list', 'hr/positions').code, 0);
		assert.equal(ws.dt('check').code, 0);
	});

	test('the module record carries its declaration', () => {
		const ws = twoModuleWorkspace();
		const rec = JSON.parse(ws.dt('get', 'modules/hr', '--json').stdout);
		assert.deepEqual(rec.namespaces, ['hr']);
		assert.equal(JSON.parse(ws.dt('get', 'modules/core', '--json').stdout).namespaces, undefined,
			'a module declaring none has the key ABSENT — the commons');
	});

	test('a workspace declaration and a module declaration both land, longest-first', () => {
		const ws = twoModuleWorkspace({ namespaces: ['finance', 'finance/tax'] });
		assert.deepEqual(manifest(ws).namespaces, ['finance/tax', 'finance', 'hr'],
			'normalizeNamespaces sorts longest-first — parent-first would read finance/tax/x as namespace finance');
	});

	test('a reference splits against the union, from the manifest, with nothing in package.json', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('add', 'hr/positions', '--name', 'Engineer').code, 0);
		const res = ws.dt('get', 'hr/positions/engineer', '--json');
		assert.equal(res.code, 0, res.stderr);
		assert.equal(JSON.parse(res.stdout).name, 'Engineer');
	});
});

describe('one owner per namespace', () => {
	test('two modules declaring the same namespace is a compile ERROR naming both', () => {
		const ws = twoModuleWorkspace({ compile: false });
		writeModule(ws.root, 'people-ops', { namespaces: ['hr'] });
		const res = ws.dt('compile');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /namespace "hr" is declared by hr AND people-ops — one owner/);
		assert.match(res.stderr, /dt set modules\/<m> namespaces=/);
	});

	test('a workspace declaration duplicating a module\'s is a WARNING, not an error', () => {
		// Every existing workspace declares at the workspace level; an upgrade must not brick compile.
		const ws = twoModuleWorkspace({ namespaces: ['hr'] });
		assert.equal(ws.out.code, 0);
		const warned = ws.out.warnings.join('\n');
		assert.match(warned, /namespace "hr" is declared both by module hr and at the workspace level/);
		assert.match(warned, /dt set modules\/hr namespaces=hr/);
		assert.deepEqual(manifest(ws).namespaces, ['hr'], 'the union de-duplicates it');
	});

	test('dt set modules/<m> namespaces= removes the duplicate workspace entry in the SAME write', () => {
		const ws = twoModuleWorkspace({ namespaces: ['hr'] });
		const res = ws.dt('set', 'modules/hr', 'namespaces=hr');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.equal(JSON.parse(readFile(ws.root, 'package.json')).dreamteamer.namespaces, undefined,
			'the workspace copy goes with the write that makes it redundant — otherwise the warning is permanent');
		assert.deepEqual(JSON.parse(readFile(ws.root, 'modules/hr/package.json')).dreamteamer.namespaces, ['hr']);
		assert.doesNotMatch(ws.dt('compile').stderr, /declared both by module/);
	});
});

describe('using another module\'s namespace requires the dependency', () => {
	const GRADES = 'name: hr/grades\ndescription: A pay band.\nid: { generate: "{{ name | slug }}" }\nstorage: { suffix: grade }\n'
		+ 'schema:\n  type: object\n  required: [name]\n  properties:\n    name: { type: string }\n';

	test('a module shipping hr/<c> without depending on hr is a compile error', () => {
		const ws = twoModuleWorkspace({ compile: false });
		fs.mkdirSync(path.join(ws.root, 'modules/core/collections/hr'), { recursive: true });
		fs.writeFileSync(path.join(ws.root, 'modules/core/collections/hr/grades.collection.yaml'), GRADES);
		const res = ws.dt('compile');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /collection "hr\/grades" sits in namespace "hr", which module hr declares/);
		assert.match(res.stderr, /dt set modules\/core dependencies=modules\/hr/);
	});

	test('with the dependency declared it compiles', () => {
		const ws = twoModuleWorkspace({ compile: false });
		fs.mkdirSync(path.join(ws.root, 'modules/core/collections/hr'), { recursive: true });
		fs.writeFileSync(path.join(ws.root, 'modules/core/collections/hr/grades.collection.yaml'), GRADES);
		patchModulePkg(ws.root, 'core', { dependencies: ['hr'] });
		const res = ws.dt('compile');
		assert.equal(res.code, 0, res.stderr);
		assert.equal(ws.dt('add', 'hr/grades', '--name', 'Band 4').code, 0);
		assert.ok(readFile(ws.root, 'data/hr/grades/band-4.grade.md'));
	});

	test('the OWNING module needs no declaration for its own namespace', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.out.code, 0, 'hr ships hr/positions and declares hr — nothing else is needed');
	});
});

describe('THE BARE-WORKSPACE GATE — decision 130\'s test, which it never had', () => {
	test('a namespaced module copied ALONE into a virgin dt init workspace compiles', () => {
		const source = twoModuleWorkspace();
		const bare = bareWorkspace(source.root, 'hr');

		// The virgin workspace declares nothing at all — that is the point.
		assert.equal(JSON.parse(readFile(bare.root, 'package.json')).dreamteamer.namespaces, undefined);
		assert.equal(fs.existsSync(path.join(bare.root, 'modules', 'core')), false, 'core is NOT installed');

		const res = bare.dt('compile');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.deepEqual(load(readFile(bare.root, '.dreamteamer/manifest.yaml')).namespaces, ['hr'],
			'the module carried its own namespace in');
		assert.ok(readFile(bare.root, '.dreamteamer/collections/hr/positions.collection.yaml'),
			'the namespaced descriptor compiled, nested, and is loadable');
	});

	test('and it is USABLE alone: add, list, get, check', () => {
		const source = twoModuleWorkspace();
		const bare = bareWorkspace(source.root, 'hr');
		assert.equal(bare.dt('compile').code, 0);
		assert.equal(bare.dt('add', 'hr/positions', '--name', 'Engineer').code, 0);
		assert.match(bare.dt('list', 'hr/positions').stdout, /engineer/);
		assert.equal(JSON.parse(bare.dt('get', 'hr/positions/engineer', '--json').stdout).name, 'Engineer');
		const check = bare.dt('check');
		assert.equal(check.code, 0, check.stdout);
	});

	test('its unresolved PEER is excused rather than failing — which is what makes a peer a peer', () => {
		const source = twoModuleWorkspace();
		const bare = bareWorkspace(source.root, 'hr');
		const out = bare.dt('compile');
		assert.equal(out.code, 0, out.stderr);
		const d = load(readFile(bare.root, '.dreamteamer/collections/hr/positions.collection.yaml'));
		assert.deepEqual(d.unresolved_peers, ['people'],
			'stated as DATA on the descriptor, so check.js can excuse the reference without learning what a module is');
		assert.equal(bare.dt('check').code, 0);
	});
});

describe('namespace inference from --module', () => {
	test('a module declaring exactly ONE namespace infers it, and the resolved name is echoed', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('add', 'collections', '--name', 'grades', '--module', 'hr');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.match(res.stdout, /✔ hr\/grades \(namespace inferred from module hr\)/);
		assert.ok(readFile(ws.root, 'modules/hr/collections/hr/grades.collection.yaml'));
		assert.equal(load(readFile(ws.root, '.dreamteamer/collections/hr/grades.collection.yaml')).storage.path, 'data/hr/grades');
	});

	test('a declared prefix already in --name is never doubled', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('add', 'collections', '--name', 'hr/grades', '--module', 'hr');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.ok(readFile(ws.root, 'modules/hr/collections/hr/grades.collection.yaml'));
		assert.equal(readFile(ws.root, 'modules/hr/collections/hr/hr/grades.collection.yaml'), null);
	});

	test('TWO declared namespaces refuse to guess', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('set', 'modules/hr', 'namespaces=hr,hr/payroll').code, 0);
		const res = ws.dt('add', 'collections', '--name', 'grades', '--module', 'hr');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /module hr declares hr\/payroll, hr — say which: --namespace/);
	});

	test("--namespace '' means NO namespace, the dt set convention for clearing", () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('add', 'collections', '--name=grades', '--module=hr', '--namespace=');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.ok(readFile(ws.root, 'modules/hr/collections/grades.collection.yaml'));
		assert.match(res.stdout, /✔ grades/);
	});

	test('a module declaring NONE gives unprefixed names — the commons', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('add', 'collections', '--name', 'grades', '--module', 'core');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.ok(readFile(ws.root, 'modules/core/collections/grades.collection.yaml'));
	});

	test('--namespace naming a namespace NOBODY declares writes the declaration into the target module', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('add', 'collections', '--name', 'plans', '--module', 'core', '--namespace', 'ops');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.deepEqual(JSON.parse(readFile(ws.root, 'modules/core/package.json')).dreamteamer.namespaces, ['ops'],
			'a namespace a collection needs is declared where that collection lives — otherwise the verb writes a source that cannot compile');
		assert.ok(readFile(ws.root, 'modules/core/collections/ops/plans.collection.yaml'));
		assert.equal(ws.dt('check').code, 0);
	});

	test('with no --module the declaration goes to the WORKSPACE, as before', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('add', 'collections', '--name', 'plans', '--namespace', 'ops').code, 0);
		assert.deepEqual(JSON.parse(readFile(ws.root, 'package.json')).dreamteamer.namespaces, ['ops']);
	});

	test('a bare --namespace is refused BEFORE anything is written', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('add', 'collections', '--name', 'plans', '--namespace');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /--namespace takes a value/);
		assert.equal(readFile(ws.root, 'modules/default/collections/plans.collection.yaml'), null,
			'the guard runs before the write — a refusal that lands a committed change lies twice');
	});
});

describe('the stated trade', () => {
	test('removing a namespace-owning module makes the compile error name it', () => {
		const ws = twoModuleWorkspace();
		ws.dt('add', 'hr/positions', '--name', 'Engineer');
		// ⚠ THE DEPENDENCY FIRST. §8's own rule: core cannot ship a collection in hr's namespace
		// without depending on hr, so the move is illegal until that is declared — the gate compile
		// refuses it, which is the rule working rather than a fixture problem.
		patchModulePkg(ws.root, 'core', { dependencies: ['hr'], peerDependencies: ['people'] });
		assert.equal(ws.dt('compile').code, 0);
		// move the collection out so `rm --force` is not what breaks it, then drop the module
		const moved = ws.dt('set', 'collections/hr/positions', 'module=core');
		assert.equal(moved.code, 0, moved.stdout + moved.stderr);
		const res = ws.dt('rm', 'modules/hr', '--force');
		assert.equal(res.code, 1, 'core still needs the namespace hr declares');
		assert.match(res.stderr, /by a module you just removed or disabled/);
	});
});
