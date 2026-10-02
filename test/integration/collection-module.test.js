// Tier 2 — a collection's OWNING MODULE as data, and moving it as a field write.
//
// §7: "move a collection to another module" is `dt set collections/teams module=hr`; nav ordering
// is a different act, `dt reorder collections/teams --after tasks`. The move relocates the
// descriptor SOURCE and leaves the RECORDS where they are: a namespace and a `storage.path` are
// properties of the collection, not of the module, so a move never changes an id.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { twoModuleWorkspace, patchModulePkg, readFile, WS_MODULE } from '../helpers/ws.js';
import { load } from '../../src/yaml.js';
import { moduleOf, overlaidByOf, storageOf, fieldsOf } from '../../src/descriptor.js';

const compiled = (ws, name) => load(readFile(ws.root, `.dreamteamer/collections/${name}.collection.yaml`));

// hr's overlay on core's `people` — a second source of the same collection, marked `overlay: true`
const PEOPLE_OVERLAY = 'name: people\noverlay: true\nfields:\n  badge:\n    type: string\n';
// the workspace module's overlay on core's `teams`
const TEAMS_OVERLAY = 'name: teams\noverlay: true\nfields:\n  tag:\n    type: string\n';

describe('provenance is DATA on the compiled descriptor', () => {
	test('module names the owner as a bare id', () => {
		const ws = twoModuleWorkspace();
		const d = compiled(ws, 'people');
		assert.equal(moduleOf(d), 'core', 'the id the operator types — `--module core`, `modules/core`');
		assert.equal(d.owner, undefined, 'the reference form is not written — `compiled.module` is the one spelling');
		assert.deepEqual(overlaidByOf(d), [], 'no overlays');
	});

	test('an overlay is visible, and the BASE still owns the concept', () => {
		const ws = twoModuleWorkspace();
		patchModulePkg(ws.root, 'hr', { dependencies: ['core'], peer_collections: ['people'] });
		fs.writeFileSync(path.join(ws.root, 'modules/hr/collections/people.collection.yaml'), PEOPLE_OVERLAY);
		assert.equal(ws.dt('compile').code, 0);
		const d = compiled(ws, 'people');
		assert.equal(moduleOf(d), 'core', 'an overlay adds fields to somebody else\'s collection; it does not take it over');
		assert.deepEqual(overlaidByOf(d), ['hr']);
		assert.equal(fieldsOf(d).badge.type, 'string');
	});

	test('dt get collections/<c> shows module and overlays', () => {
		const ws = twoModuleWorkspace();
		const rec = JSON.parse(ws.dt('get', 'collections/people', '--json').stdout);
		assert.equal(moduleOf(rec), 'core', 'the record is the compiled descriptor, so the owner is compiled.module');
	});

	test('dt get collections/<c> --module <m> prints THAT module\'s source contribution alone', () => {
		const ws = twoModuleWorkspace();
		patchModulePkg(ws.root, 'hr', { dependencies: ['core'], peer_collections: ['people'] });
		fs.writeFileSync(path.join(ws.root, 'modules/hr/collections/people.collection.yaml'), PEOPLE_OVERLAY);
		assert.equal(ws.dt('compile').code, 0);
		const own = JSON.parse(ws.dt('get', 'collections/people', '--module', 'hr', '--json').stdout);
		assert.deepEqual(Object.keys(own.fields), ['badge'],
			'the OVERLAY\'s contribution, not the merged descriptor');
		assert.equal(own.overlay, true);
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
		assert.equal(moduleOf(compiled(ws, 'teams')), 'hr');
		assert.equal(storageOf(compiled(ws, 'teams')).path, 'data/teams');
		assert.equal(ws.dt('check').code, 0);
		assert.equal(ws.git(['rev-list', '--count', `${before}..HEAD`]), '1', 'ONE commit');
	});

	test('a namespaced collection keeps its namespace and its folder', () => {
		const ws = twoModuleWorkspace();
		ws.dt('add', 'hr/positions', '--name', 'Engineer');
		// §8: `hr` is hr's namespace, so core must DEPEND on hr to ship a collection inside it —
		// the same rule an overlay has. The move is legal once that is declared.
		patchModulePkg(ws.root, 'core', { dependencies: ['hr'] });
		assert.equal(ws.dt('compile').code, 0);
		const moved = ws.dt('set', 'collections/hr/positions', 'module=core');
		assert.equal(moved.code, 0, moved.stdout + moved.stderr);
		assert.ok(readFile(ws.root, 'modules/core/collections/hr/positions.collection.yaml'),
			'the nested source path follows the collection NAME, not the module');
		assert.ok(readFile(ws.root, 'data/hr/positions/engineer.position.md'));
		assert.equal(storageOf(compiled(ws, 'hr/positions')).path, 'data/hr/positions');
	});

	test('an overlay names no module, so moving its base leaves it untouched', () => {
		const ws = twoModuleWorkspace();
		patchModulePkg(ws.root, 'default', { dependencies: ['core'] });
		fs.writeFileSync(path.join(ws.root, 'modules/default/collections/teams.collection.yaml'), TEAMS_OVERLAY);
		assert.equal(ws.dt('compile').code, 0);
		// the overlaying module must depend on the NEW owner too
		patchModulePkg(ws.root, 'default', { dependencies: ['core', 'hr'] });
		const res = ws.dt('set', 'collections/teams', 'module=hr');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.equal(readFile(ws.root, 'modules/default/collections/teams.collection.yaml'), TEAMS_OVERLAY);
		assert.deepEqual(overlaidByOf(compiled(ws, 'teams')), [WS_MODULE]);
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
		assert.match(res.stderr, /peer_collections/);
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
	test('description, nav icon and order, and list columns land in the owning module\'s source', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('set', 'collections/teams', 'description=A group with a shared remit.',
			'display.nav.icon=groups', 'display.nav.order=40', 'display.list.columns=name');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		const src = load(readFile(ws.root, 'modules/core/collections/teams.collection.yaml'));
		assert.equal(src.description, 'A group with a shared remit.');
		assert.equal(src.display.nav.icon, 'groups');
		assert.equal(src.display.nav.order, 40, 'a numeric scalar is written as a number, not "40"');
		assert.deepEqual(src.display.list.columns, ['name'], 'a list scalar takes the comma spelling');
	});

	test('an empty value removes the key', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('set', 'collections/teams', 'display.nav.icon=groups').code, 0);
		assert.equal(ws.dt('set', 'collections/teams', 'display.nav.icon=').code, 0);
		assert.equal(load(readFile(ws.root, 'modules/core/collections/teams.collection.yaml')).display?.nav?.icon, undefined);
	});

	test('a scalar and module= in one call is refused — they are different acts', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('set', 'collections/teams', 'module=hr', 'display.nav.icon=groups');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /module= moves the collection/);
	});

	test('a field of the SCHEMA is refused, with the verb that does it', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('set', 'collections/teams', 'name=nope');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /"name" is not a settable key of a collection/);
		assert.match(res.stderr, /dreamteamer rename collections\/teams/);
	});

	test('a list column naming no field is refused — a dangling column compiles clean', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('set', 'collections/people', 'display.list.columns=name,nickname');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /people has no field nickname/);
		assert.match(res.stderr, /dreamteamer add-field people --name nickname/);
	});

	test('a comment in the descriptor survives a scalar write', () => {
		const ws = twoModuleWorkspace();
		const file = path.join(ws.root, 'modules/core/collections/teams.collection.yaml');
		fs.writeFileSync(file, `# WHY this collection exists: a remit, not a headcount.\n${fs.readFileSync(file, 'utf8')}`);
		assert.equal(ws.dt('compile').code, 0);
		assert.equal(ws.dt('set', 'collections/teams', 'display.nav.icon=groups').code, 0);
		assert.match(readFile(ws.root, 'modules/core/collections/teams.collection.yaml'),
			/# WHY this collection exists/);
	});
});

describe('--module targets one module\'s contribution', () => {
	test('add collections --module puts the descriptor in that module', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('add', 'collections', '--name', 'grades', '--module', 'hr');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		// ⚠ hr declares the namespace `hr` (§8), so the resolved name is `hr/grades` and the source
		// is nested to match. The echo says so — namespace inference is never silent.
		assert.ok(readFile(ws.root, 'modules/hr/collections/hr/grades.collection.yaml'));
		assert.equal(moduleOf(compiled(ws, 'hr/grades')), 'hr');
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
		patchModulePkg(ws.root, 'hr', { dependencies: ['core'], peer_collections: ['people'] });
		assert.equal(ws.dt('compile').code, 0);
		const res = ws.dt('add-field', 'people', '--name', 'badge', '--type', 'string', '--module', 'hr');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		const overlay = load(readFile(ws.root, 'modules/hr/collections/people.collection.yaml'));
		assert.equal(overlay.overlay, true);
		assert.equal(overlay.fields.badge.type, 'string');
		assert.deepEqual(overlaidByOf(compiled(ws, 'people')), ['hr']);
	});

	test('an overlay write with the dependency MISSING is rolled back and names the fix', () => {
		const ws = twoModuleWorkspace();
		// teams, not people: hr declares people a peer, which lets it overlay people with no dependency
		const res = ws.dt('add-field', 'teams', '--name', 'badge', '--type', 'string', '--module', 'hr');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /rolled back — dt set modules\/hr dependencies=modules\/core, then re-run/);
		assert.equal(readFile(ws.root, 'modules/hr/collections/teams.collection.yaml'), null,
			'nothing was left behind');
	});

	test('rm-field --module removes from the overlay, and its LAST field removes the file', () => {
		const ws = twoModuleWorkspace();
		patchModulePkg(ws.root, 'hr', { dependencies: ['core'], peer_collections: ['people'] });
		assert.equal(ws.dt('compile').code, 0);
		assert.equal(ws.dt('add-field', 'people', '--name', 'badge', '--type', 'string', '--module', 'hr').code, 0);
		const res = ws.dt('rm-field', 'people', '--name', 'badge', '--module', 'hr');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.equal(readFile(ws.root, 'modules/hr/collections/people.collection.yaml'), null,
			'an overlay whose last field is gone is not a descriptor anybody meant to keep');
		assert.equal(ws.dt('check').code, 0);
	});

	test('--module on a SINGLY-declared field is refused as a selector that selects nothing', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('set-field', 'people', '--name', 'name', '--module', 'core',
			'--description', 'Their name.');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /people\.name is declared only by core — drop --module/);
	});

	test('an unknown --module names the known ones', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('add-field', 'people', '--name', 'badge', '--type', 'string', '--module', 'nope');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /no module "nope" — known: /);
	});
});

describe('--dry-run on the other destructive verbs', () => {
	test('rename collections/<c> prints the plan and writes nothing', () => {
		const ws = twoModuleWorkspace();
		ws.dt('add', 'teams', '--name', 'Platform');
		const res = ws.dt('rename', 'collections/teams', 'hr/teams', '--dry-run');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /dry run/);
		assert.match(res.stdout, /records 1 · refs 0 · descriptors 1 · values cleared 0/);
		assert.ok(readFile(ws.root, 'modules/core/collections/teams.collection.yaml'), 'nothing renamed');
		assert.ok(readFile(ws.root, 'data/teams/platform.team.md'));
	});

	test('rm-field on a POPULATED field counts the values it would clear', () => {
		const ws = twoModuleWorkspace();
		// ⚠ `employer` is ALREADY declared by the fixture's `people` — an `add-field` here would be
		// refused as a duplicate, which is the correct behaviour and the wrong prep.
		ws.dt('add', 'people', '--name', 'Dana Levi', '--employer', 'Acme');
		ws.dt('add', 'people', '--name', 'Sam Ortiz');
		const res = ws.dt('rm-field', 'people', '--name', 'employer', '--dry-run');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /values cleared 1/, 'one of the two records carries a value');
		assert.ok(load(readFile(ws.root, 'modules/core/collections/people.collection.yaml')).fields.employer,
			'the field is still declared');
	});
});
