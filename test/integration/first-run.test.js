// FIRST RUN of a workspace by a stranger — the seven-item report of 2026-09-24, from an agent
// setting up a fresh workspace inside code-server: nothing named the editor extension, the
// missing-env warning pointed at a file that did not list the key, shipped modules warned about
// fields the operator could not edit, and nobody could tell whether the extension was active.
// Each assertion here is one of those, pinned as behaviour of `init`, `compile` and `status`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { twoModuleWorkspace, readFile, patchModulePkg } from '../helpers/ws.js';
import { ensureEditorRecommendation, ensureEnvExample, EDITOR_EXTENSION_ID } from '../../src/workspace.js';

const ID = 'dreamteamer.dreamteamer-vscode';

describe('the editor is named to the editor — .vscode/extensions.json', () => {
	test('init writes the recommendation, and compile keeps it (the fixture was made by init)', () => {
		const ws = twoModuleWorkspace();
		const file = path.join(ws.root, '.vscode', 'extensions.json');
		assert.ok(fs.existsSync(file), 'init wrote no .vscode/extensions.json');
		assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).recommendations, [ID]);
		fs.rmSync(path.join(ws.root, '.vscode'), { recursive: true });
		assert.equal(ws.dt('compile').code, 0);
		assert.ok(fs.existsSync(file), 'compile did not restore the recommendation');
	});

	test('an existing file is merged: other recommendations survive, the id is added once', () => {
		const ws = twoModuleWorkspace();
		const file = path.join(ws.root, '.vscode', 'extensions.json');
		fs.writeFileSync(file, JSON.stringify({ recommendations: ['esbenp.prettier-vscode'], unwantedRecommendations: ['x.y'] }) + '\n');
		assert.equal(ensureEditorRecommendation(ws.root), 'merged');
		const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
		assert.deepEqual(parsed.recommendations, ['esbenp.prettier-vscode', ID]);
		assert.deepEqual(parsed.unwantedRecommendations, ['x.y']);
		assert.equal(ensureEditorRecommendation(ws.root), 'present');
		assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).recommendations, ['esbenp.prettier-vscode', ID], 'the id was added twice');
	});

	test('a commented (jsonc) file that already names the id is left byte-for-byte alone; one that does not is left with a warning', () => {
		const ws = twoModuleWorkspace();
		const file = path.join(ws.root, '.vscode', 'extensions.json');
		const jsonc = `{\n\t// the studio extension\n\t"recommendations": ["${ID}"]\n}\n`;
		fs.writeFileSync(file, jsonc);
		assert.equal(ensureEditorRecommendation(ws.root), 'present');
		assert.equal(fs.readFileSync(file, 'utf8'), jsonc);
		fs.writeFileSync(file, '{\n\t// nothing yet\n\t"recommendations": []\n}\n');
		const warnings = [];
		assert.equal(ensureEditorRecommendation(ws.root, (m) => warnings.push(m)), 'left');
		assert.match(warnings[0], /not plain JSON, so it was left alone/);
		assert.equal(EDITOR_EXTENSION_ID, ID);
	});
});

describe('declared env keys are described, and .env.example names them', () => {
	test('a module may declare { name, description, example }; the warning carries the description and .env.example gains the key', () => {
		const ws = twoModuleWorkspace();
		patchModulePkg(ws.root, 'core', { env: [{ name: 'WORK_CALENDARS', description: 'the calendars /fetch-meetings reads, comma-separated ids', example: 'primary,team@example.invalid' }, 'PLAIN_KEY'] });
		fs.writeFileSync(path.join(ws.root, '.env'), 'OTHER=1\n');
		const r = ws.dt('compile');
		assert.equal(r.code, 0, r.stderr);
		assert.match(r.stderr, /module core declares env key WORK_CALENDARS \(the calendars \/fetch-meetings reads, comma-separated ids\) — missing from \.env \(see \.env\.example\)/);
		assert.match(r.stderr, /module core declares env key PLAIN_KEY — missing/);
		const example = readFile(ws.root, '.env.example');
		assert.match(example, /# the calendars \/fetch-meetings reads, comma-separated ids \(module core\)\nWORK_CALENDARS=primary,team@example\.invalid/);
		assert.match(example, /# declared by core\nPLAIN_KEY=/);
		assert.match(r.stdout, /✔ \.env\.example now names WORK_CALENDARS, PLAIN_KEY/);
		// idempotent: a second compile adds nothing and says nothing about it
		const again = ws.dt('compile');
		assert.doesNotMatch(again.stdout, /\.env\.example now names/);
		assert.equal(readFile(ws.root, '.env.example'), example);
	});

	test('a key the operator already listed in .env.example (even commented out) is not added again', () => {
		const ws = twoModuleWorkspace();
		fs.writeFileSync(path.join(ws.root, '.env.example'), '# my notes\n# WORK_CALENDARS=already-here\n');
		const added = ensureEnvExample(ws.root, [{ key: 'WORK_CALENDARS', modules: ['core'] }, { key: 'NEW_ONE', modules: ['core'], description: 'brand new' }]);
		assert.deepEqual(added, ['NEW_ONE']);
		const text = readFile(ws.root, '.env.example');
		assert.equal((text.match(/WORK_CALENDARS/g) ?? []).length, 1);
		assert.match(text, /# brand new \(module core\)\nNEW_ONE=/);
	});

	test('a malformed env declaration is a compile error naming the module', () => {
		const ws = twoModuleWorkspace();
		patchModulePkg(ws.root, 'core', { env: [{ description: 'no name' }] });
		const r = ws.dt('compile');
		assert.equal(r.code, 1);
		assert.match(r.stderr + r.stdout, /module "core": dreamteamer\.env entry .* a key is an identifier/);
	});
});

describe('a shipped module\'s wildcard references are the author\'s warning, not the consumer\'s', () => {
	test('x-reference "*" in an INLINE module still warns; the same field in a node_modules module does not', () => {
		const ws = twoModuleWorkspace();
		// inline: the core module gains a polymorphic field
		const inline = path.join(ws.root, 'modules', 'core', 'collections', 'tasks.collection.yaml');
		fs.writeFileSync(inline, fs.readFileSync(inline, 'utf8').replace(/^    owner:/m, "    item:\n      type: string\n      x-reference: '*'\n    owner:"));
		const r1 = ws.dt('compile');
		assert.equal(r1.code, 0, r1.stderr);
		assert.match(r1.stderr, /collection tasks: field "item" uses x-reference: '\*' outside the workspace module/);
		// npm: the same shape delivered through node_modules, declared as a dependency
		const pkgDir = path.join(ws.root, 'node_modules', '@acme', 'shipped');
		fs.mkdirSync(path.join(pkgDir, 'collections'), { recursive: true });
		fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@acme/shipped', version: '1.0.0', dreamteamer: {} }));
		fs.writeFileSync(path.join(pkgDir, 'collections', 'tickets.collection.yaml'), [
			'name: tickets', 'description: A shipped ticket.', 'schema:', '  type: object', '  properties:', '    name: { type: string }', "    about: { type: string, x-reference: '*' }", '',
		].join('\n'));
		const pkgFile = path.join(ws.root, 'package.json');
		const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
		pkg.dependencies = { ...pkg.dependencies, '@acme/shipped': '1.0.0' };
		fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, '\t') + '\n');
		const r2 = ws.dt('compile');
		assert.equal(r2.code, 0, r2.stderr);
		assert.match(r2.stderr, /collection tasks: field "item"/, 'the inline warning must still be raised');
		assert.doesNotMatch(r2.stderr, /collection tickets: field "about"/, 'a consumer was warned about a module it does not own');
		assert.ok(fs.existsSync(path.join(ws.root, '.dreamteamer', 'collections', 'tickets.collection.yaml')), 'the shipped module did not compile at all');
	});
});

describe('dt status says whether the editor is active', () => {
	test('no marker → "not detected" with the id; a marker → its version, state, time and engine', () => {
		const ws = twoModuleWorkspace();
		const none = ws.dt('status');
		assert.equal(none.code, 0, none.stderr);
		assert.match(none.stdout, /^editor: not detected — the extension dreamteamer\.dreamteamer-vscode writes \.dreamteamer\/editor\.json/m);
		fs.writeFileSync(path.join(ws.root, '.dreamteamer', 'editor.json'), JSON.stringify({ extension: ID, version: '0.19.0', engine: '0.27.0', state: 'active', activated: '2026-09-24T12:00:00.000Z', host: 'code-server 1.138.0' }));
		const some = ws.dt('status');
		assert.match(some.stdout, /^editor: dreamteamer\.dreamteamer-vscode 0\.19\.0 · active 2026-09-24T12:00:00\.000Z · engine 0\.27\.0 · code-server 1\.138\.0$/m);
		fs.writeFileSync(path.join(ws.root, '.dreamteamer', 'editor.json'), JSON.stringify({ extension: ID, version: '0.19.0', engine: '0.18.2', state: 'engine-too-old', activated: 'x' }));
		assert.match(ws.dt('status').stdout, /editor: .* engine-too-old/);
	});
});

describe('the dependency audit a stranger runs', () => {
	test('yaml is pinned at or above the patched 2.8.3', () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
		const [maj, min, pat] = pkg.dependencies.yaml.replace(/^[^\d]*/, '').split('.').map(Number);
		assert.ok(maj > 2 || (maj === 2 && (min > 8 || (min === 8 && pat >= 3))), `yaml ${pkg.dependencies.yaml} is inside the GHSA-48c2-rrv3-qjmp range`);
	});
});
