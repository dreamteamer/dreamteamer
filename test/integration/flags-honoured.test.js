// A FLAG THE CLI ACCEPTS AND DOES NOT READ IS A SILENT WRONG ANSWER.
//
// This file exists because 0.19.0 shipped green — 892/892, `layers` and `metrics:check` clean, CI
// green, published — and a three-command walk of the flow the release exists FOR found two defects
// in it. The suite asserted that `help` LISTS every verb and that each one DISPATCHES. Nothing
// asserted that a flag is HONOURED, so the arg parser silently swallowing what it does not
// recognise had no coverage at all.
//
// Four classes are pinned here, and every one of them was a real escape:
//
//   1. an unknown flag is REFUSED (it used to be accepted and dropped, so a typo was
//      indistinguishable from a supported flag)
//   2. `--dry-run` PLANS (it used to EXECUTE on four of the six verbs that document it, and the
//      write self-commits, so the destruction was durable)
//   3. a misspelled `--dry-run` never executes — the worst instance of class 1, because the
//      swallowed flag is the one standing between a plan and a delete
//   4. an unknown flag on a READ verb is refused rather than applied as a filter on a field that
//      does not exist — `dt list people --fliter name=Ada` answered "(no people matching)" at
//      exit 0, which reads as a fact about the collection
//
// ⚠ The point of every assertion below is the BEHAVIOUR, not the reachability of a code path. An
// assertion that a flag parses would have passed against the released build.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { twoModuleWorkspace, readFile, ENGINE_ROOT } from '../helpers/ws.js';
import { FIELD_FLAGS } from '../../src/collections-cli.js';

const exists = (root, rel) => fs.existsSync(path.join(root, rel));

describe('--dry-run PLANS — it never destroys (the data-loss class)', () => {
	test('rm collections/<c> --dry-run --force prints a plan and leaves the descriptor on disk', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('add', 'collections', '--name', 'widgets', '--module', 'core').code, 0);
		const src = 'modules/core/collections/widgets.collection.yaml';
		assert.ok(exists(ws.root, src), 'fixture: the descriptor should exist before the dry run');

		const res = ws.dt('rm', 'collections/widgets', '--dry-run', '--force');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /dry run — dreamteamer rm collections\/widgets/);
		assert.match(res.stdout, /records \d+ · refs \d+ · descriptors 1 · values cleared \d+/);
		assert.doesNotMatch(res.stdout, /✔ removed collection/);
		assert.ok(exists(ws.root, src), 'the DRY RUN deleted the descriptor');
	});

	test('rm skills/<id> --dry-run leaves SKILL.md on disk', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('add', 'skills', '--name', 'tmpskill', '--description', 'A scratch skill.').code, 0);
		const src = 'modules/default/skills/tmpskill/SKILL.md';
		assert.ok(exists(ws.root, src));

		const res = ws.dt('rm', 'skills/tmpskill', '--dry-run');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /dry run — dreamteamer rm skills\/tmpskill/);
		assert.doesNotMatch(res.stdout, /✔ removed skill/);
		assert.ok(exists(ws.root, src), 'the DRY RUN deleted the skill');
	});

	test('rm ui-views/<id> --dry-run leaves the view source on disk', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('add', 'ui-views', '--path', '/zz', '--target', 'list', '--collection', 'collections/people', '--layout', 'table').code, 0);
		const src = 'modules/default/ui-views/zz.ui-view.yaml';
		assert.ok(exists(ws.root, src));

		const res = ws.dt('rm', 'ui-views/zz', '--dry-run');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /dry run — dreamteamer rm ui-views\/zz/);
		assert.doesNotMatch(res.stdout, /✔ removed ui-view/);
		assert.ok(exists(ws.root, src), 'the DRY RUN deleted the view');
	});

	test('rm <collection>/<id> --dry-run leaves the RECORD on disk', () => {
		const ws = twoModuleWorkspace({ records: { people: [{ name: 'Ada Byron' }] } });
		const src = 'data/people/ada-byron.person.md';
		assert.ok(exists(ws.root, src));

		const res = ws.dt('rm', 'people/ada-byron', '--dry-run', '--force');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /dry run — dreamteamer rm people\/ada-byron/);
		assert.doesNotMatch(res.stdout, /^✔ removed$/m);
		assert.ok(exists(ws.root, src), 'the DRY RUN deleted the record');
	});

	// ⚠ THE WORST INSTANCE OF THE SWALLOWED FLAG, and the reason the two classes are one file: the
	// flag being dropped is the one standing between a plan and a delete, so a one-character typo
	// silently becomes a real destructive run that then self-commits.
	test('a MISSPELLED --dry-run never executes a destructive field verb', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('add-field', 'people', '--name', 'badge', '--type', 'string').code, 0);

		const res = ws.dt('remove-field', 'people', '--name', 'badge', '--dryrun');
		assert.equal(res.code, 1, `--dryrun was accepted and the field was REMOVED:\n${res.stdout}`);
		assert.match(res.stderr, /unknown flag "--dryrun"/);
		assert.match(res.stderr, /--dry-run/); // the nearest valid spelling
		assert.match(readFile(ws.root, 'modules/core/collections/people.collection.yaml'), /badge/);
	});

	test('a MISSPELLED --dry-run never executes a rename-field', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('add-field', 'people', '--name', 'badge', '--type', 'string').code, 0);

		const res = ws.dt('rename-field', 'people', '--name', 'badge', '--to', 'pass', '--dry-runn');
		assert.equal(res.code, 1, `--dry-runn was accepted and the rename EXECUTED:\n${res.stdout}`);
		assert.match(res.stderr, /unknown flag "--dry-runn"/);
		assert.match(readFile(ws.root, 'modules/core/collections/people.collection.yaml'), /badge/);
	});
});

describe('an unknown flag on a READ verb is refused, not applied as a filter', () => {
	const ws = twoModuleWorkspace({ records: { people: [{ name: 'Ada Byron' }] } });

	test('list <c> --bogusflag is refused rather than answering "(no people matching)"', () => {
		const res = ws.dt('list', 'people', '--bogusflag', 'x');
		assert.equal(res.code, 1, `accepted and applied as a filter:\n${res.stdout}`);
		assert.match(res.stderr, /unknown flag "--bogusflag"/);
		assert.doesNotMatch(res.stdout, /no people matching/);
	});

	test('a ONE-CHARACTER typo of --filter names the flag it meant', () => {
		const res = ws.dt('list', 'people', '--fliter', 'name=Ada Byron');
		assert.equal(res.code, 1, `accepted and applied as a filter:\n${res.stdout}`);
		assert.match(res.stderr, /unknown flag "--fliter"/);
		assert.match(res.stderr, /did you mean --filter\?/);
	});

	// ⚠ A REFUSAL THAT REJECTS A VALID FLAG IS WORSE THAN THE SILENCE IT REPLACES. Both halves of
	// `list`'s vocabulary have to survive: its own options, and the bare-field shorthand filters,
	// which are ordinary field names and cannot be enumerated by any table.
	test('every legitimate list flag still works — options AND the bare-field shorthand', () => {
		assert.equal(ws.dt('list', 'people', '--json').code, 0);
		assert.equal(ws.dt('list', 'people', '--sort', 'name').code, 0);
		assert.equal(ws.dt('list', 'people', '--filter', 'name=Ada Byron').code, 0);
		assert.equal(ws.dt('list', 'people', '--where', '{"name":{"_eq":"Ada Byron"}}').code, 0);
		const byField = ws.dt('list', 'people', '--name', 'Ada Byron');
		assert.equal(byField.code, 0, byField.stderr);
		assert.match(byField.stdout, /ada-byron/);
	});
});

describe('an unknown flag is refused on every verb that has a closed vocabulary', () => {
	const ws = twoModuleWorkspace({ records: { people: [{ name: 'Ada Byron' }] } });
	ws.dt('add-field', 'people', '--name', 'badge', '--type', 'string');

	// The representative set. Each row is what the operator types MINUS the bogus flag, so a row
	// that starts failing for its own reasons is a red test rather than a false green.
	const rows = [
		['add modules', ['add', 'modules', '--name', 'zz']],
		['add collections', ['add', 'collections', '--name', 'zz']],
		['add skills', ['add', 'skills', '--name', 'zz', '--description', 'x']],
		['add ui-views', ['add', 'ui-views', '--path', '/zz', '--target', 'list', '--layout', 'table']],
		['add <record>', ['add', 'people', '--name', 'Grace']],
		['set <record>', ['set', 'people/ada-byron', 'badge=x']],
		['set collections', ['set', 'collections/people', 'icon=person']],
		['set modules', ['set', 'modules/core', 'description=x']],
		['rm <record>', ['rm', 'people/ada-byron', '--force']],
		['rm collections', ['rm', 'collections/teams', '--force']],
		['rm modules', ['rm', 'modules/hr', '--force']],
		['rename <record>', ['rename', 'people/ada-byron', 'ada']],
		['rename collections', ['rename', 'collections/teams', 'crews']],
		['move collections', ['move', 'collections/teams', '--top']],
		['get', ['get', 'people/ada-byron']],
		['values', ['values', 'people', 'name']],
		['history', ['history', 'people/ada-byron']],
		['diff', ['diff', 'people/ada-byron']],
		['add-field', ['add-field', 'people', '--name', 'zz', '--type', 'string']],
		['update-field', ['update-field', 'people', '--name', 'badge', '--type', 'text']],
		['remove-field', ['remove-field', 'people', '--name', 'badge']],
		['rename-field', ['rename-field', 'people', '--name', 'badge', '--to', 'pass']],
		['relations', ['relations', 'people']],
		['ensure', ['ensure', '--all']],
	];

	for (const [label, args] of rows) {
		test(`${label} refuses --bogusflag`, () => {
			const res = ws.dt(...args, '--bogusflag', 'x');
			assert.equal(res.code, 1, `\`dt ${label}\` accepted --bogusflag and ran anyway:\n${res.stdout}`);
			assert.match(res.stderr, /unknown flag "--bogusflag"/);
			assert.match(res.stderr, /known:/);
		});
	}

	test('the full legitimate add-field vocabulary is still accepted', () => {
		const w = twoModuleWorkspace();
		const res = w.dt(
			'add-field', 'people',
			'--name', 'team', '--type', 'teams', '--many', '--inverse', 'members',
			'--inverse-description', 'Who is on it.', '--description', 'The team.',
			'--on-delete', 'set-null', '--required', 'false',
		);
		assert.equal(res.code, 0, res.stderr);
		const res2 = w.dt('add-field', 'people', '--name', 'grade', '--type', 'enum', '--options', 'a,b', '--default-value', 'a');
		assert.equal(res2.code, 0, res2.stderr);
		// `--unique` and `--mirror-of` are RELATION keywords, so they belong on a reference type. The
		// point here is that the PARSER lets them through, not that a scalar accepts them.
		const res3 = w.dt('add-field', 'teams', '--name', 'lead', '--type', 'people', '--unique', '--inverse', 'leads');
		assert.doesNotMatch(res3.stderr, /unknown flag/);
		const res4 = w.dt('add-field', 'tasks', '--name', 'crew', '--type', 'teams', '--mirror-of', 'teams.tasks');
		assert.doesNotMatch(res4.stderr, /unknown flag/);
	});
});

// ⚠ THE ALLOWLIST IS NOW COUPLED TO `fieldDef`, and nothing else would say so. Adding a flag to the
// field verbs without adding it here makes the parser refuse a flag the implementation reads — the
// one failure mode a refusal must not have — and the symptom would be a verb that stopped working
// rather than one that reads a flag it should not.
test('every flag schema-ops reads off a field verb is in the allowlist', () => {
	const src = fs.readFileSync(path.join(ENGINE_ROOT, 'src', 'schema-ops.js'), 'utf8');
	const read = new Set([...src.matchAll(/flags(?:\.([a-zA-Z][\w-]*)|\['([\w-]+)'\])/g)].map((m) => m[1] ?? m[2]));
	const missing = [...read].filter((f) => !FIELD_FLAGS.includes(f)).sort();
	assert.deepEqual(missing, [], `schema-ops reads flags the CLI would now refuse: ${missing.join(', ')}`);
});

describe('add ui-views honours the flags it takes and refuses the ones it does not', () => {
	test('an unknown flag is NOT written into the view record as a field', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('add', 'ui-views', '--path', '/zz', '--target', 'list', '--collection', 'collections/people', '--layout', 'table', '--wibble', 'wobble');
		assert.equal(res.code, 1, `--wibble was accepted:\n${res.stdout}`);
		assert.match(res.stderr, /unknown flag "--wibble"/);
		assert.equal(readFile(ws.root, 'modules/default/ui-views/zz.ui-view.yaml'), null, 'an invalid view was written AND self-committed');
	});

	test('--module <m> puts the view in that module rather than being written in as a field', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('add', 'ui-views', '--path', '/zz', '--target', 'list', '--collection', 'collections/people', '--layout', 'table', '--module', 'core');
		assert.equal(res.code, 0, res.stderr);
		assert.ok(exists(ws.root, 'modules/core/ui-views/zz.ui-view.yaml'), '--module was ignored');
		assert.doesNotMatch(readFile(ws.root, 'modules/core/ui-views/zz.ui-view.yaml'), /^module:/m);
	});
});

describe('add modules --namespace declares the namespace IN THE MODULE (§6.2, §8)', () => {
	test('the declaration lands in package.json AND in the compiled manifest', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('add', 'modules', '--name', 'payroll', '--namespace', 'payroll');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /declared namespace "payroll"/);

		const pkg = JSON.parse(readFile(ws.root, 'modules/payroll/package.json'));
		assert.deepEqual(pkg.dreamteamer.namespaces, ['payroll'], '--namespace was silently ignored');
		assert.match(readFile(ws.root, '.dreamteamer/manifest.yaml'), /payroll/);
	});

	test('a collection added with --module then gets the PREFIXED name, echoed', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('add', 'modules', '--name', 'payroll', '--namespace', 'payroll').code, 0);

		const res = ws.dt('add', 'collections', '--name', 'slots', '--module', 'payroll');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /✔ payroll\/slots \(namespace inferred from module payroll\)/);
		assert.ok(exists(ws.root, 'modules/payroll/collections/payroll/slots.collection.yaml'));
	});

	test('a declared prefix already present in --name is not doubled', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('add', 'modules', '--name', 'payroll', '--namespace', 'payroll').code, 0);
		const res = ws.dt('add', 'collections', '--name', 'payroll/slots', '--module', 'payroll');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /✔ payroll\/slots/);
		assert.doesNotMatch(res.stdout, /payroll\/payroll/);
	});

	test('a bare --namespace on add modules is refused BEFORE the module is created', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('add', 'modules', '--name', 'payroll', '--namespace');
		assert.equal(res.code, 1, res.stdout);
		assert.match(res.stderr, /--namespace takes a value/);
		assert.ok(!exists(ws.root, 'modules/payroll'), 'the module was created anyway');
	});
});

describe('a system `set` that changes nothing says so instead of leaking a git failure', () => {
	test('set collections/<c> to the value it already has exits 0', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('set', 'collections/people', 'icon=person').code, 0);

		const res = ws.dt('set', 'collections/people', 'icon=person');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /nothing to do/);
		assert.doesNotMatch(res.stderr, /git commit failed/);
		assert.doesNotMatch(res.stderr, /Command failed/);
	});

	test('set modules/<id> to the value it already has exits 0', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('set', 'modules/core', 'description=The shared nouns.').code, 0);
		const res = ws.dt('set', 'modules/core', 'description=The shared nouns.');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /nothing to do/);
	});
});

describe('a write into a node_modules-owned collection is refused where it is refused everywhere else', () => {
	test('set collections/<c> names npm install rather than a compile that will never help', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('set', 'collections/repos', 'icon=folder');
		assert.equal(res.code, 1, res.stdout);
		assert.match(res.stderr, /node_modules/);
		assert.match(res.stderr, /npm install/);
		assert.doesNotMatch(res.stderr, /run `dreamteamer compile` and re-run/);
	});
});

describe('rename-field rewrites EVERY surface that names the field, options.sort included', () => {
	test("a ui-view's options.sort follows the rename, with and without the - prefix", () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('add-field', 'people', '--name', 'email', '--type', 'string').code, 0);
		assert.equal(ws.dt('add', 'ui-views', '--path', '/pp', '--target', 'list', '--collection', 'collections/people', '--layout', 'table', 'options.columns=name,email', 'options.sort=-email').code, 0);
		assert.equal(ws.dt('add', 'ui-views', '--path', '/qq', '--target', 'list', '--collection', 'collections/people', '--layout', 'table', 'options.sort=email').code, 0);

		const res = ws.dt('rename-field', 'people', '--name', 'email', '--to', 'mail');
		assert.equal(res.code, 0, res.stderr);
		assert.match(readFile(ws.root, 'modules/default/ui-views/pp.ui-view.yaml'), /sort: '?-mail'?/);
		assert.match(readFile(ws.root, 'modules/default/ui-views/qq.ui-view.yaml'), /sort: '?mail'?/);
	});
});

describe("revert on a system entity hands over a path that actually matches something", () => {
	test('the git pathspec it prints resolves to a real file', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('revert', 'modules/core');
		assert.equal(res.code, 1);
		assert.doesNotMatch(res.stderr, /modules\/\*\/modules\//, 'the hint names a path that matches nothing');
		const hint = /git checkout <sha> -- (\S+)/.exec(res.stderr)?.[1];
		assert.ok(hint, res.stderr);
		const hits = ws.git(['ls-files', '--', hint]);
		assert.ok(hits.length > 0, `\`git ls-files -- ${hint}\` matched nothing`);
	});
});
