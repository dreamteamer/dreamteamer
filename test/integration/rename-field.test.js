// Tier 2 — `rename-field`, the ONE capability a `fields` core collection would have bought.
//
// It was cut on the core test: `surface.collections` is 9/9 with zero headroom, and a `fields`
// collection would project 1,010 files per compile in a 71-collection workspace. Renaming a field
// is a VERB, not a noun — and it is the verb with the widest blast radius in this engine, because a
// field name is referenced by NAME (not by a `<collection>/<id>` reference) in eight different
// places, and `store.rewriteRefs` can see none of them.
//
// ⚠ `people` in the fixture ALREADY declares `employer` (test/helpers/ws.js), so there is no
// `add-field employer` prep anywhere here — an `add-field` on a field that exists is refused, which
// is correct behaviour and the wrong setup.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { twoModuleWorkspace, patchModulePkg, readFile } from '../helpers/ws.js';
import { load } from '../../src/yaml.js';

const src = (ws, mod, name) => load(readFile(ws.root, `modules/${mod}/collections/${name}.collection.yaml`));

describe('the values', () => {
	test('the key is rewritten in every record, in ONE commit', () => {
		const ws = twoModuleWorkspace();
		ws.dt('add', 'people', '--name', 'Dana Levi', '--employer', 'Acme');
		ws.dt('add', 'people', '--name', 'Sam Ortiz');
		const before = ws.git(['rev-parse', 'HEAD']);

		const res = ws.dt('rename-field', 'people', '--name', 'employer', '--to', 'company');
		assert.equal(res.code, 0, res.stdout + res.stderr);

		assert.equal(src(ws, 'core', 'people').schema.properties.employer, undefined);
		assert.equal(src(ws, 'core', 'people').schema.properties.company.type, 'string');
		const dana = readFile(ws.root, 'data/people/dana-levi.person.md');
		assert.match(dana, /^company: Acme$/m);
		assert.doesNotMatch(dana, /employer/);
		assert.doesNotMatch(readFile(ws.root, 'data/people/sam-ortiz.person.md'), /company/,
			'a record that never carried the field is not rewritten');
		assert.equal(ws.git(['rev-list', '--count', `${before}..HEAD`]), '1', 'ONE commit');
		assert.equal(ws.dt('check').code, 0);
	});

	test('a required entry follows the rename', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('rename-field', 'people', '--name', 'name', '--to', 'full_name').code, 0);
		const d = src(ws, 'core', 'people');
		assert.deepEqual(d.schema.required, ['full_name']);
		assert.equal(ws.dt('check').code, 0);
	});

	test('the BODY field keeps its prose', () => {
		const ws = twoModuleWorkspace();
		ws.dt('add', 'people', '--name', 'Dana Levi', '--notes', 'Met at Acme.');
		assert.equal(ws.dt('rename-field', 'people', '--name', 'notes', '--to', 'summary').code, 0);
		const rec = readFile(ws.root, 'data/people/dana-levi.person.md');
		assert.match(rec, /Met at Acme\./, 'the prose is the text after the frontmatter — it has no key to rewrite');
		assert.equal(src(ws, 'core', 'people').schema.properties.summary['x-body'], true);
		assert.equal(JSON.parse(ws.dt('get', 'people/dana-levi', '--json').stdout).summary, 'Met at Acme.');
	});
});

describe('every surface that names a field by NAME', () => {
	test('list_fields and sort_field in the same descriptor', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('set', 'collections/people', 'list_fields=name,employer').code, 0);
		assert.equal(ws.dt('set', 'collections/people', 'sort_field=employer').code, 0);
		assert.equal(ws.dt('rename-field', 'people', '--name', 'employer', '--to', 'company').code, 0);
		const d = src(ws, 'core', 'people');
		assert.deepEqual(d.list_fields, ['name', 'company']);
		assert.equal(d.sort_field, 'company');
	});

	test('a list_fields entry naming no field is refused before anything moves', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('set', 'collections/people', 'list_fields=name,nickname');
		assert.equal(res.code, 1, 'nickname does not exist — the scalar setter does not invent it');
		assert.match(res.stderr, /people has no field nickname/);
	});

	test('title_template and id.generate', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('set', 'collections/teams', 'title_template={{ name }}').code, 0);
		assert.equal(ws.dt('rename-field', 'teams', '--name', 'name', '--to', 'label').code, 0);
		const d = src(ws, 'core', 'teams');
		assert.equal(d.title_template, '{{ label }}');
		assert.equal(d.id.generate, '{{ label | slug }}', 'a filter in the template survives');
		assert.equal(ws.dt('add', 'teams', '--label', 'Platform').code, 0);
		assert.ok(readFile(ws.root, 'data/teams/platform.team.md'));
	});

	test('x-inverse on the OWNER, and the generated mirror with it', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('update-field', 'tasks', '--name', 'owner', '--type', 'people',
			'--inverse', 'tasks').code, 0);
		ws.dt('add', 'people', '--name', 'Dana Levi');
		ws.dt('add', 'tasks', '--name', 'Ship it', '--owner', 'people/dana-levi');
		// rename the MIRROR's name via the owner's keyword
		assert.equal(ws.dt('rename-field', 'people', '--name', 'tasks', '--to', 'assigned').code, 0);
		const owner = src(ws, 'core', 'tasks');
		assert.equal(owner.schema.properties.owner['x-inverse'], 'assigned',
			'the mirror is GENERATED from this keyword — renaming the field means renaming the keyword');
		assert.match(readFile(ws.root, 'data/people/dana-levi.person.md'), /^assigned:/m);
		assert.equal(ws.dt('check').code, 0);
	});

	test('x-inverse-of, which names <collection>.<field> on the far side', () => {
		const ws = twoModuleWorkspace();
		// spelling B: the mirror declares the relation from the side that wants it
		assert.equal(ws.dt('add-field', 'people', '--name', 'tasks',
			'--mirror-of', 'tasks.owner').code, 0);
		assert.equal(ws.dt('rename-field', 'tasks', '--name', 'owner', '--to', 'assignee').code, 0);
		const mirror = src(ws, 'core', 'people');
		const holder = mirror.schema.properties.tasks.items ?? mirror.schema.properties.tasks;
		assert.equal(holder['x-inverse-of'], 'tasks.assignee',
			'the LAST dot splits it — a collection name may contain a slash but never a dot');
		assert.equal(ws.dt('check').code, 0);
	});

	test("a ui-view's options.columns and its filter", () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('add', 'ui-views', '--path', '/staff', '--target', 'list',
			'--collection', 'collections/people', '--layout', 'table',
			'options.columns=name,employer', '--filter', '{"employer":{"_eq":"Acme"}}').code, 0);
		assert.equal(ws.dt('rename-field', 'people', '--name', 'employer', '--to', 'company').code, 0);
		const view = load(readFile(ws.root, 'modules/default/ui-views/staff.ui-view.yaml'));
		assert.deepEqual(view.options.columns, ['name', 'company']);
		assert.deepEqual(view.filter, { company: { _eq: 'Acme' } },
			'a filter narrows what the operator SEES — a stale key narrows to nothing, silently');
	});

	test("a command-binding's can-enter and can-exit", () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('add-field', 'people', '--name', 'status', '--type', 'enum',
			'--options', 'draft,done').code, 0);
		fs.mkdirSync(path.join(ws.root, 'modules/default/commands'), { recursive: true });
		fs.writeFileSync(path.join(ws.root, 'modules/default/commands/enrich.command.md'),
			'---\nname: enrich\ndescription: Fill a person in.\n---\n\nDo the thing.\n');
		fs.mkdirSync(path.join(ws.root, 'modules/default/command-bindings'), { recursive: true });
		// the id `add-view` would derive is `{{ command | basename }}--{{ collection | basename }}`,
		// so the filename is `enrich--people` — compile takes a file-shaped record's id from the
		// FILENAME, and a name that disagrees with `id.generate` is a `check` finding waiting to happen
		fs.writeFileSync(path.join(ws.root, 'modules/default/command-bindings/enrich--people.command-binding.yaml'),
			'command: commands/enrich\ncollection: collections/people\ntarget: record\n'
			+ 'can-enter: { status: { _eq: draft } }\ncan-exit: { status: { _eq: done } }\n');
		assert.equal(ws.dt('compile').code, 0);
		assert.equal(ws.dt('rename-field', 'people', '--name', 'status', '--to', 'stage').code, 0);
		const b = load(readFile(ws.root, 'modules/default/command-bindings/enrich--people.command-binding.yaml'));
		assert.deepEqual(b['can-enter'], { stage: { _eq: 'draft' } });
		assert.deepEqual(b['can-exit'], { stage: { _eq: 'done' } });
	});

	test('an OVERLAY in another module is rewritten too', () => {
		const ws = twoModuleWorkspace();
		patchModulePkg(ws.root, 'hr', { namespaces: ['hr'], dependencies: ['core'], peerDependencies: ['people'] });
		assert.equal(ws.dt('compile').code, 0);
		assert.equal(ws.dt('add-field', 'people', '--name', 'badge', '--type', 'string',
			'--module', 'hr').code, 0);
		const res = ws.dt('rename-field', 'people', '--name', 'badge', '--to', 'pass_id', '--module', 'hr');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.equal(src(ws, 'hr', 'people').schema.properties.pass_id.type, 'string');
		assert.equal(src(ws, 'hr', 'people').schema.properties.badge, undefined);
	});

	test('the report names every source it touched', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('set', 'collections/people', 'list_fields=name,employer').code, 0);
		const res = ws.dt('rename-field', 'people', '--name', 'employer', '--to', 'company');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /modules\/core\/collections\/people\.collection\.yaml/);
	});
});

describe('the refusals and the plan', () => {
	test('--dry-run counts and writes nothing', () => {
		const ws = twoModuleWorkspace();
		ws.dt('add', 'people', '--name', 'Dana Levi', '--employer', 'Acme');
		const res = ws.dt('rename-field', 'people', '--name', 'employer', '--to', 'company', '--dry-run');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /dry run/);
		assert.match(res.stdout, /records 1 · refs 0 · descriptors 1 · values cleared 0/);
		assert.ok(src(ws, 'core', 'people').schema.properties.employer, 'nothing renamed');
	});

	test('an absent field is refused', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('rename-field', 'people', '--name', 'nope', '--to', 'other');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /no field "nope" on people/);
	});

	test('a name already taken is refused before anything moves', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('rename-field', 'people', '--name', 'name', '--to', 'notes');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /people already has a field "notes"/);
	});

	test('renaming to the same name says so and stops', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('rename-field', 'people', '--name', 'name', '--to', 'name');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /already named that/);
	});

	test('a GENERATED mirror renamed onto a TAKEN name is refused, like any other field', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('update-field', 'tasks', '--name', 'owner', '--type', 'people',
			'--inverse', 'tasks').code, 0);
		// `people.tasks` IS generated — renaming it means renaming the owner's keyword, which the
		// earlier test proves works. The name-taken guard applies to it exactly as to an authored one.
		const res = ws.dt('rename-field', 'people', '--name', 'tasks', '--to', 'notes');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /people already has a field "notes"/);
	});

	test('a comment above the field follows it', () => {
		const ws = twoModuleWorkspace();
		const file = path.join(ws.root, 'modules/core/collections/teams.collection.yaml');
		const text = fs.readFileSync(file, 'utf8')
			.replace('    name:', '    # the remit, not the headcount\n    name:');
		fs.writeFileSync(file, text);
		assert.equal(ws.dt('compile').code, 0);
		assert.equal(ws.dt('rename-field', 'teams', '--name', 'name', '--to', 'label').code, 0);
		const after = readFile(ws.root, 'modules/core/collections/teams.collection.yaml');
		assert.match(after, /# the remit, not the headcount/, 'the comment survives — it explains the field, which still exists');
		assert.match(after, /label:/);
	});
});
