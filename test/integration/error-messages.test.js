// Tier 2 — §13's TABLE, message by message.
//
// These are not "nice error text". Every row is a sentence somebody needed and did not get, and
// several of them replace a message that was FALSE: `remove-field` on a spelling-B mirror answered
// "no descriptor declares it" while the file that declared it sat in front of the operator, and
// named a remedy that exits 0 changing nothing. A refusal that names the wrong thing costs more
// than no refusal, because it sends the reader somewhere.
//
// Asserted on the SUBSTANCE, not on punctuation: each test matches the phrases that carry the
// information and the command that fixes it, so re-wording is free and losing the remedy is not.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { twoModuleWorkspace, writeModule, patchModulePkg } from '../helpers/ws.js';

describe('§13 — the error messages the implementation must ship', () => {
	test('--module nope', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('add-field', 'people', '--name', 'badge', '--type', 'string', '--module', 'nope');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /no module "nope"/);
		assert.match(res.stderr, /known: /);
		assert.match(res.stderr, /core/);
		assert.match(res.stderr, /hr/);
		assert.match(res.stderr, /dt list modules/);
		assert.match(res.stderr, /A module is named by its id\./);
	});

	test('a write into a node_modules module names the overlay spelling as the remedy', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('add-field', 'collections', '--name', 'badge', '--type', 'string', '--module', 'dreamteamer');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /erased by the next `npm install`/);
		assert.match(res.stderr, /to add fields from this workspace: dreamteamer add-field collections --name <f> --module default/);
	});

	test('add collections on a name another module owns names BOTH remedies', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('add', 'collections', '--name', 'people', '--module', 'hr');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /collection "people" already exists, owned by core/);
		assert.match(res.stderr, /add-field people --module hr/);
		assert.match(res.stderr, /set collections\/people module=hr/);
	});

	test('an overlay write with the dependency missing is compile\'s text, PREFIXED with the fix', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('add-field', 'people', '--name', 'badge', '--type', 'string', '--module', 'hr');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /does not declare "core" in dreamteamer\.dependencies/, "compile's own sentence");
		assert.match(res.stderr, /rolled back — dt set modules\/hr dependencies=modules\/core, then re-run/);
	});

	test('two modules declaring one namespace', () => {
		const ws = twoModuleWorkspace({ compile: false });
		writeModule(ws.root, 'people-ops', { namespaces: ['hr'] });
		const res = ws.dt('compile');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /namespace "hr" is declared by hr AND people-ops — one owner/);
		assert.match(res.stderr, /Remove it from one \(dt set modules\/<m> namespaces=…\)/);
	});

	test('a module declares hr and the workspace also does — a WARNING', () => {
		const ws = twoModuleWorkspace({ namespaces: ['hr'] });
		assert.equal(ws.out.code, 0, 'a warning, never an error — an upgrade must not brick compile');
		const warned = ws.out.warnings.join('\n');
		assert.match(warned, /declared both by module hr and at the workspace level/);
		assert.match(warned, /dt set modules\/hr namespaces=hr/);
	});

	test('--module hr when hr declares two namespaces', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('set', 'modules/hr', 'namespaces=hr,hr/payroll').code, 0);
		const res = ws.dt('add', 'collections', '--name', 'grades', '--module', 'hr');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /module hr declares hr\/payroll, hr — say which: --namespace/);
	});

	test('rm modules/core while it still ships things', () => {
		const ws = twoModuleWorkspace();
		ws.dt('add', 'people', '--name', 'Dana Levi');
		const res = ws.dt('rm', 'modules/core');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /core still ships 3 collections \(people, tasks, teams\), 1 with records/);
		assert.match(res.stderr, /--force removes the sources; records stay and become unindexed/);
	});

	test('set --module on a singly-declared field', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('update-field', 'people', '--name', 'name', '--module', 'core', '--description', 'Their name.');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /people\.name is declared only by core — drop --module/);
	});

	test('an illegal move: the ring and both escapes', () => {
		const ws = twoModuleWorkspace();
		patchModulePkg(ws.root, 'hr', { namespaces: ['hr'], dependencies: ['core'] });
		assert.equal(ws.dt('compile').code, 0);
		const res = ws.dt('set', 'collections/people', 'module=hr');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /move rolled back/);
		assert.match(res.stderr, /would be a ring/);
		assert.match(res.stderr, /peerDependencies=collections\/people/);
		assert.match(res.stderr, /or move people as well/);
	});

	test('a schema write into git_modules is never a rollback', () => {
		// the full git-shape assertion lives in schema-commit-repo.test.js; this pins the SENTENCE
		const ws = twoModuleWorkspace();
		const clone = path.join(ws.root, 'git_modules', 'hr');
		fs.mkdirSync(path.dirname(clone), { recursive: true });
		fs.renameSync(path.join(ws.root, 'modules', 'hr'), clone);
		for (const args of [['init', '-q'], ['config', 'user.email', 't@example.invalid'], ['config', 'user.name', 't'], ['add', '-A'], ['commit', '-qm', 'hr']]) {
			execFileSync('git', args, { cwd: clone, stdio: 'ignore' });
		}
		ws.git(['add', '-A', '--', 'modules']);
		ws.git(['commit', '-qm', 'workspace: hr moved to a clone']);
		assert.equal(ws.dt('compile').code, 0);
		const res = ws.dt('add-field', 'hr/positions', '--name', 'grade', '--type', 'integer');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.match(res.stdout, /✔ committed in git_modules\/hr/);
		assert.match(res.stdout, /push when ready/);
		assert.doesNotMatch(res.stdout + res.stderr, /rolled back/);
	});

	test('dt schema … is gone, and the error names the new spellings', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('schema', 'add-collection', '--name', 'grades');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /unknown verb "schema"/);
		assert.match(res.stderr, /schema verbs are gone since 0\.19\.0/);
		assert.match(res.stderr, /dt add collections/);
		assert.match(res.stderr, /dt add-field <c>/);
		assert.match(res.stderr, /dt help/);
	});

	test('compile before dt install on a fresh clone names dt install', () => {
		const ws = twoModuleWorkspace({ compile: false });
		// a lockfile entry whose clone is absent — exactly what a fresh `git clone` of a vault gives
		const pkgFile = path.join(ws.root, 'package.json');
		const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
		pkg.dreamteamer['git-modules'] = { billing: { url: 'file:///nonexistent', ref: 'main' } };
		fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, '\t') + '\n');
		// a collection referencing one the absent module would provide
		fs.writeFileSync(path.join(ws.root, 'modules/core/collections/invoices.collection.yaml'),
			'name: invoices\ndescription: A bill.\nid: { generate: "{{ name | slug }}" }\nstorage: { suffix: invoice }\n'
			+ 'schema:\n  type: object\n  required: [name]\n  properties:\n    name: { type: string }\n'
			+ '    payer: { type: string, x-reference: billing-accounts }\n');
		const res = ws.dt('compile');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /billing-accounts/);
		assert.match(res.stderr, /dreamteamer install/,
			'a lockfile entry with no clone is an UNINSTALLED workspace, not a broken reference');
	});
});
