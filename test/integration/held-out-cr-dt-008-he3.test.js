// rnd/tests/dreamteamer/heldout-dt008-e-preset-ships-a-modules-folder — held-out, written by the test stage.
// A module preset that ships a modules/ bundle folder, a kind folder or a UI bundle is refused at compile
// naming the folder, and the install that brought it is restored; a clean preset installs quietly.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { offline, registry, run, out, installed, snapshot, collection, commitAll } from './held-out-cr-dt-008-lib.js';

const preset = { '@fix/a': '1.0.0' };
const BUNDLE = { name: '@fix/bundle-set', version: '1.0.0', dreamteamer: { description: 'a preset shipping a bundle', preset }, files: { 'modules/inner/package.json': JSON.stringify({ name: 'inner', version: '1.0.0', dreamteamer: {} }), 'modules/inner/collections/inners.collection.yaml': collection('inners') }, pkgFiles: ['modules'] };
let REG;
before(() => {
	REG = registry([
		BUNDLE,
		{ name: '@fix/skill-set', version: '1.0.0', dreamteamer: { description: 'a preset shipping a skill', preset }, files: { 'skills/x/SKILL.md': '---\nname: x\ndescription: use when x\n---\nx\n' } },
		{ name: '@fix/ui-set', version: '1.0.0', dreamteamer: { description: 'a preset shipping a UI bundle', preset }, files: { 'ui/app.js': 'export default {};\n' } },
		{ name: '@fix/clean-set', version: '1.0.0', dreamteamer: { description: 'a clean preset', preset, nav: 'nav.yaml' }, files: { 'README.md': '# clean\n', 'nav.yaml': 'tree:\n  - folder: Clean\n    items: [fixas]\n' } },
	]);
});

/** "preset" never bare: every occurrence in what the call printed reads "module preset". */
const bareWord = (text) => text.split('\n').filter((l) => /(?<!module )\bpreset\b/i.test(l.replace(/dreamteamer\.preset/g, '')));

describe('held-out he3 — a module preset that ships sources', () => {
	for (const [pkgName, folder] of [['@fix/bundle-set', 'modules'], ['@fix/skill-set', 'skills'], ['@fix/ui-set', 'ui']]) {
		test(`${pkgName}: refused naming ${folder}/ and the package; the install restored, @fix/a not left installed`, () => {
			const ws = offline();
			const before = snapshot(ws.root);
			const r = run(ws.root, ['install', pkgName, '--from', REG]);
			assert.equal(r.code, 1, out(r));
			assert.ok(r.stderr.includes('a module preset lists modules; it ships none'), out(r));
			assert.ok(r.stderr.includes(`found ${folder}/`), `names ${folder}/: ${out(r)}`);
			assert.ok(r.stderr.includes(pkgName), `names the package: ${out(r)}`);
			assert.match(r.stderr + r.stdout, /are as before the call/, 'the restore line is printed');
			const after = snapshot(ws.root);
			assert.equal(after.pkg, before.pkg, 'package.json as before');
			assert.equal(after.lock, before.lock, 'package-lock.json as before');
			assert.deepEqual(after.fix, before.fix, 'node_modules/@fix as before');
			assert.equal(installed(ws.root, '@fix/a'), null, '@fix/a is NOT left installed');
			assert.equal(fs.existsSync(path.join(ws.root, '.dreamteamer', 'collections', 'inners.collection.yaml')), false, 'inners never compiled');
			assert.deepEqual(bareWord(r.stderr + r.stdout), [], 'never a bare "preset"');
		});
	}

	test('@fix/clean-set: installs, no "contributed no recognised sources" warning', () => {
		const ws = offline();
		const r = run(ws.root, ['install', '@fix/clean-set', '--from', REG]);
		assert.equal(r.code, 0, out(r));
		assert.doesNotMatch(r.stdout + r.stderr, /contributed no recognised sources/);
		assert.equal(installed(ws.root, '@fix/a'), '1.0.0');
		assert.deepEqual(bareWord(r.stderr + r.stdout), [], 'never a bare "preset"');
	});

	test('step 3: the bundle-set as an inline module fails dt compile with the same sentence', () => {
		const ws = offline();
		const dir = path.join(ws.root, 'modules', 'bundle-set');
		fs.mkdirSync(path.join(dir, 'modules', 'inner', 'collections'), { recursive: true });
		const { files, pkgFiles, ...manifest } = BUNDLE;
		fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ description: 'x', files: pkgFiles, ...manifest }, null, '\t') + '\n');
		for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), text);
		commitAll(ws.root, 'inline bundle-set');
		const r = run(ws.root, ['compile']);
		assert.notEqual(r.code, 0, out(r));
		assert.ok((r.stderr + r.stdout).includes('a module preset lists modules; it ships none (found modules/)'), out(r));
		assert.ok((r.stderr + r.stdout).includes('@fix/bundle-set'), out(r));
		assert.equal(fs.existsSync(path.join(ws.root, '.dreamteamer', 'collections', 'inners.collection.yaml')), false, 'inners never compiled');
		assert.deepEqual(bareWord(r.stderr + r.stdout), [], 'never a bare "preset"');
	});
});
