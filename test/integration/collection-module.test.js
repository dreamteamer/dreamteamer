// Tier 2 — a collection's OWNING MODULE as data, and moving it as a field write.
//
// §7: "move a collection to another module" is `dt set collections/teams module=hr`, not `move` —
// `move` is nav ordering, and `order` is a settable scalar now, so `dt move collections/teams
// --after tasks` means exactly that. The move relocates the descriptor SOURCE and leaves the
// RECORDS where they are: a namespace and a `storage.path` are properties of the collection, not of
// the module, so a move never changes an id.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { twoModuleWorkspace, patchModulePkg, readFile } from '../helpers/ws.js';
import { load } from '../../src/yaml.js';

const compiled = (ws, name) => load(readFile(ws.root, `.dreamteamer/collections/${name}.collection.yaml`));

describe('provenance is DATA on the compiled descriptor', () => {
	test('module names the owner as a bare id, and owner keeps its reference form for one release', () => {
		const ws = twoModuleWorkspace();
		const d = compiled(ws, 'people');
		assert.equal(d.module, 'core', 'the id the operator types — `--module core`, `modules/core`');
		assert.equal(d.owner, 'modules/core', 'the pre-0.19 reference form, kept one release for the extension');
		assert.equal(d.overlays, undefined, 'no overlays means the key is ABSENT, not an empty list');
	});

	test('an overlay is visible, and the BASE still owns the concept', () => {
		const ws = twoModuleWorkspace();
		patchModulePkg(ws.root, 'hr', { dependencies: ['core'], peerDependencies: ['people'] });
		fs.writeFileSync(path.join(ws.root, 'modules/hr/collections/people.collection.yaml'),
			'name: people\nextends: core/people\nschema:\n  properties:\n    badge: { type: string }\n');
		assert.equal(ws.dt('compile').code, 0);
		const d = compiled(ws, 'people');
		assert.equal(d.module, 'core', 'an overlay adds fields to somebody else\'s collection; it does not take it over');
		assert.deepEqual(d.overlays, ['hr']);
		assert.equal(d.schema.properties.badge.type, 'string');
	});

	test('dt get collections/<c> shows module and overlays', () => {
		const ws = twoModuleWorkspace();
		const rec = JSON.parse(ws.dt('get', 'collections/people', '--json').stdout);
		assert.equal(rec.module, 'core');
	});

	test('dt get collections/<c> --module <m> prints THAT module\'s source contribution alone', () => {
		const ws = twoModuleWorkspace();
		patchModulePkg(ws.root, 'hr', { dependencies: ['core'], peerDependencies: ['people'] });
		fs.writeFileSync(path.join(ws.root, 'modules/hr/collections/people.collection.yaml'),
			'name: people\nextends: core/people\nschema:\n  properties:\n    badge: { type: string }\n');
		assert.equal(ws.dt('compile').code, 0);
		const own = JSON.parse(ws.dt('get', 'collections/people', '--module', 'hr', '--json').stdout);
		assert.deepEqual(Object.keys(own.schema.properties), ['badge'],
			'the OVERLAY\'s contribution, not the merged descriptor');
		assert.equal(own.extends, 'core/people');
	});
});

describe('dt set collections/<c> module=<m> — the move', () => {
	test('relocates the descriptor source and leaves the records where they are', () => {
		const ws = twoModuleWorkspace();
		ws.dt('add', 'teams', '--name', 'Platform');
		const before = ws.git(['rev-parse', 'HEAD']);

		const res = ws.dt('set', 'collections/teams', 'module=hr');
		assert.equal(res.code, 0, res.stdout + res.stderr);

		assert.ok(readFile(ws.root, 'modules/hr/collections/teams.collection.yaml'), 'descriptor moved');
		assert.equal(readFile(ws.root, 'modules/core/collections/teams.collection.yaml'), null);
		assert.ok(readFile(ws.root, 'data/teams/platform.team.md'), 'records stay — a move never changes an id');
		assert.equal(compiled(ws, 'teams').module, 'hr');
		assert.equal(compiled(ws, 'teams').storage.path, 'data/teams');
		assert.equal(ws.dt('check').code, 0);
		assert.equal(ws.git(['rev-list', '--count', `${before}..HEAD`]), '1', 'ONE commit');
	});

	test('a namespaced collection keeps its namespace and its folder', () => {
		const ws = twoModuleWorkspace();
		ws.dt('add', 'hr/positions', '--name', 'Engineer');
		assert.equal(ws.dt('set', 'collections/hr/positions', 'module=core').code, 0);
		assert.ok(readFile(ws.root, 'modules/core/collections/hr/positions.collection.yaml'),
			'the nested source path follows the collection NAME, not the module');
		assert.ok(readFile(ws.root, 'data/hr/positions/engineer.position.md'));
		assert.equal(compiled(ws, 'hr/positions').storage.path, 'data/hr/positions');
	});

	test('an overlay\'s extends follows the base, in the same commit', () => {
		const ws = twoModuleWorkspace();
		patchModulePkg(ws.root, 'default', { dependencies: ['core'] });
		fs.writeFileSync(path.join(ws.root, 'modules/default/collections/teams.collection.yaml'),
			'name: teams\nextends: core/teams\nschema:\n  properties:\n    tag: { type: string }\n');
		assert.equal(ws.dt('compile').code, 0);
		// the overlaying module must depend on the NEW owner too
		patchModulePkg(ws.root, 'default', { dependencies: ['core', 'hr'] });
		const res = ws.dt('set', 'collections/teams', 'module=hr');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.equal(load(readFile(ws.root, 'modules/default/collections/teams.collection.yaml')).extends, 'hr/teams');
	});

	test('an ILLEGAL move is refused with the fix, and nothing is touched', () => {
		const ws = twoModuleWorkspace();
		patchModulePkg(ws.root, 'hr', { dependencies: ['core'] });
		assert.equal(ws.dt('compile').code, 0);
		// `people` is referenced by core's `tasks.owner`. Moving `people` to hr makes core depend on
		// hr, and hr already depends on core — a ring.
		const res = ws.dt('set', 'collections/people', 'module=hr');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /move rolled back/);
		assert.match(res.stderr, /a ring/);
		assert.match(res.stderr, /peerDependencies/);
		assert.ok(readFile(ws.root, 'modules/core/collections/people.collection.yaml'), 'nothing moved');
		assert.equal(readFile(ws.root, 'modules/hr/collections/people.collection.yaml'), null);
		assert.equal(ws.dt('check').code, 0);
	});

	test('--dry-run prints the plan and writes nothing', () => {
		const ws = twoModuleWorkspace();
		ws.dt('add', 'teams', '--name', 'Platform');
		const res = ws.dt('set', 'collections/teams', 'module=hr', '--dry-run');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /dry run/);
		assert.match(res.stdout, /records 1 · refs 0 · descriptors 1 · values cleared 0/);
		assert.ok(readFile(ws.root, 'modules/core/collections/teams.collection.yaml'), 'nothing moved');
	});

	test('a move to the module that already owns it says so and stops', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('set', 'collections/teams', 'module=core');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /already owned by core/);
	});

	test('an unknown module names the known ones', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('set', 'collections/teams', 'module=nope');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /no module "nope" — known: /);
		assert.match(res.stderr, /A module is named by its id\./);
	});

	test('an npm-shipped collection cannot be moved', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('set', 'collections/collections', 'module=core');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /compiled source|node_modules/);
	});
});

describe('dt set collections/<c> — the collection-level scalars', () => {
	test('description, icon, title, order and list_fields land in the owning module\'s source', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('set', 'collections/teams', 'description=A group with a shared remit.',
			'icon=groups', 'order=40', 'list_fields=name');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		const src = load(readFile(ws.root, 'modules/core/collections/teams.collection.yaml'));
		assert.equal(src.description, 'A group with a shared remit.');
		assert.equal(src.icon, 'groups');
		assert.equal(src.order, 40, 'a numeric scalar is written as a number, not "40"');
		assert.deepEqual(src.list_fields, ['name'], 'a list scalar takes the comma spelling');
	});

	test('an empty value removes the key', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('set', 'collections/teams', 'icon=groups').code, 0);
		assert.equal(ws.dt('set', 'collections/teams', 'icon=').code, 0);
		assert.equal(load(readFile(ws.root, 'modules/core/collections/teams.collection.yaml')).icon, undefined);
	});

	test('a scalar and module= in one call is refused — they are different acts', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('set', 'collections/teams', 'module=hr', 'icon=groups');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /module= moves the collection/);
	});

	test('a field of the SCHEMA is refused, with the verb that does it', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('set', 'collections/teams', 'name=nope');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /"name" is not a settable scalar of a collection/);
		assert.match(res.stderr, /dreamteamer rename collections\/teams/);
	});

	test('a list_fields entry naming no field is refused — a dangling column compiles clean', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('set', 'collections/people', 'list_fields=name,nickname');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /people has no field nickname/);
		assert.match(res.stderr, /dreamteamer add-field people --name nickname/);
	});

	test('a comment in the descriptor survives a scalar write', () => {
		const ws = twoModuleWorkspace();
		const file = path.join(ws.root, 'modules/core/collections/teams.collection.yaml');
		fs.writeFileSync(file, `# WHY this collection exists: a remit, not a headcount.\n${fs.readFileSync(file, 'utf8')}`);
		assert.equal(ws.dt('compile').code, 0);
		assert.equal(ws.dt('set', 'collections/teams', 'icon=groups').code, 0);
		assert.match(readFile(ws.root, 'modules/core/collections/teams.collection.yaml'),
			/# WHY this collection exists/);
	});
});

describe('--module targets one module\'s contribution', () => {
	test('add collections --module puts the descriptor in that module', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('add', 'collections', '--name', 'grades', '--module', 'hr');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.ok(readFile(ws.root, 'modules/hr/collections/grades.collection.yaml'));
		assert.equal(compiled(ws, 'grades').module, 'hr');
	});

	test('add collections with no --module lands in the workspace module, as before', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('add', 'collections', '--name', 'grades').code, 0);
		assert.ok(readFile(ws.root, 'modules/default/collections/grades.collection.yaml'));
	});

	test('add collections --module on a name another module owns names both remedies', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('add', 'collections', '--name', 'people', '--module', 'hr');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /collection "people" already exists, owned by core/);
		assert.match(res.stderr, /add-field people --module hr/);
		assert.match(res.stderr, /set collections\/people module=hr/);
	});

	test('add-field --module writes an OVERLAY in that module', () => {
		const ws = twoModuleWorkspace();
		patchModulePkg(ws.root, 'hr', { dependencies: ['core'], peerDependencies: ['people'] });
		assert.equal(ws.dt('compile').code, 0);
		const res = ws.dt('schema', 'add-field', 'people', '--name', 'badge', '--type', 'string', '--module', 'hr');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		const overlay = load(readFile(ws.root, 'modules/hr/collections/people.collection.yaml'));
		assert.equal(overlay.extends, 'core/people');
		assert.equal(overlay.schema.properties.badge.type, 'string');
		assert.deepEqual(compiled(ws, 'people').overlays, ['hr']);
	});

	test('an overlay write with the dependency MISSING is rolled back and names the fix', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('schema', 'add-field', 'people', '--name', 'badge', '--type', 'string', '--module', 'hr');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /rolled back — dt set modules\/hr dependencies=modules\/core, then re-run/);
		assert.equal(readFile(ws.root, 'modules/hr/collections/people.collection.yaml'), null,
			'nothing was left behind');
	});

	test('remove-field --module removes from the overlay, and its LAST field removes the file', () => {
		const ws = twoModuleWorkspace();
		patchModulePkg(ws.root, 'hr', { dependencies: ['core'], peerDependencies: ['people'] });
		assert.equal(ws.dt('compile').code, 0);
		assert.equal(ws.dt('schema', 'add-field', 'people', '--name', 'badge', '--type', 'string', '--module', 'hr').code, 0);
		const res = ws.dt('schema', 'remove-field', 'people', '--name', 'badge', '--module', 'hr');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.equal(readFile(ws.root, 'modules/hr/collections/people.collection.yaml'), null,
			'an overlay whose last field is gone is not a descriptor anybody meant to keep');
		assert.equal(ws.dt('check').code, 0);
	});

	test('--module on a SINGLY-declared field is refused as a selector that selects nothing', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('schema', 'update-field', 'people', '--name', 'name', '--module', 'core',
			'--description', 'Their name.');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /people\.name is declared only by core — drop --module/);
	});

	test('an unknown --module names the known ones', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('schema', 'add-field', 'people', '--name', 'badge', '--type', 'string', '--module', 'nope');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /no module "nope" — known: /);
	});
});

describe('--dry-run on the other destructive verbs', () => {
	test('rename collections/<c> prints the plan and writes nothing', () => {
		const ws = twoModuleWorkspace();
		ws.dt('add', 'teams', '--name', 'Platform');
		const res = ws.dt('schema', 'rename-collection', 'teams', 'hr/teams', '--dry-run');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /dry run/);
		assert.match(res.stdout, /records 1 · refs 0 · descriptors 1 · values cleared 0/);
		assert.ok(readFile(ws.root, 'modules/core/collections/teams.collection.yaml'), 'nothing renamed');
		assert.ok(readFile(ws.root, 'data/teams/platform.team.md'));
	});

	test('remove-field on a POPULATED field counts the values it would clear', () => {
		const ws = twoModuleWorkspace();
		// ⚠ `employer` is ALREADY declared by the fixture's `people` — an `add-field` here would be
		// refused as a duplicate, which is the correct behaviour and the wrong prep.
		ws.dt('add', 'people', '--name', 'Dana Levi', '--employer', 'Acme');
		ws.dt('add', 'people', '--name', 'Sam Ortiz');
		const res = ws.dt('schema', 'remove-field', 'people', '--name', 'employer', '--dry-run');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /values cleared 1/, 'one of the two records carries a value');
		assert.ok(load(readFile(ws.root, 'modules/core/collections/people.collection.yaml')).schema.properties.employer,
			'the field is still declared');
	});
});
