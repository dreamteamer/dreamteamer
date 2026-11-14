// The fragment merge (cr-dt-008, design §3–4): a module's shipped nav.yaml fragment is checked for ownership —
// a module places only what it owns or overlays, a module preset only what its members do — then merged into
// the workspace's nav.yaml, adding only what is unplaced. A name nothing installed owns is dropped without
// a word (a removed preset member); a name another module owns refuses and writes nothing.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, writeModule, patchModulePkg, simpleCollection, compileQuietly, readFile } from '../helpers/ws.js';
import { applyNavFragments, navSettings, navGuard, NavFragmentRefusal, NAV_GUARD_LINE } from '../../src/nav-fragments.js';
import { readNavDoc } from '../../src/nav.js';

function fragment(root, id, text) {
	fs.writeFileSync(path.join(root, 'modules', id, 'nav.yaml'), text);
	patchModulePkg(root, id, { nav: 'nav.yaml' });
}

function fixture() {
	const ws = workspace();
	const root = ws.root;
	writeModule(root, 'alpha', { collections: { alphas: simpleCollection() } });
	fragment(root, 'alpha', 'tree:\n  - folder: Alpha\n    items: [alphas]\n');
	writeModule(root, 'beta', { collections: { betas: simpleCollection() } });
	// a module preset ships no folders: written by hand, not by writeModule (which lays out collections/)
	const pack = path.join(root, 'modules', 'pack');
	fs.mkdirSync(pack, { recursive: true });
	fs.writeFileSync(path.join(pack, 'package.json'), JSON.stringify({ name: 'pack', private: true, version: '1.0.0', dreamteamer: { preset: { alpha: '0.0.1', beta: '0.0.1' }, nav: 'nav.yaml' } }, null, '\t') + '\n');
	fs.writeFileSync(path.join(pack, 'nav.yaml'), 'tree:\n  - folder: Pack\n    items: [alphas, betas, gammas]\n');
	writeModule(root, 'rogue', { collections: { rogues: simpleCollection() } });
	fragment(root, 'rogue', 'tree:\n  - folder: Rogue\n    items: [rogues, betas]\n');
	writeModule(root, 'nsmod', { namespaces: ['fixns'], collections: { 'fixns/items': simpleCollection() } });
	fragment(root, 'nsmod', 'tree:\n  - namespace: fixns\n    items: [fixns/items]\n');
	writeModule(root, 'nsrogue', {});
	fragment(root, 'nsrogue', 'tree:\n  - namespace: fixns\n');
	const out = compileQuietly(ws.ws);
	assert.equal(out.code, 0, out.stdout.join('\n'));
	return root;
}

describe('applyNavFragments', () => {
	test('a module preset places its members\' collections; a name nothing owns is dropped; a second call writes nothing', () => {
		const root = fixture();
		const r = applyNavFragments(root, { names: ['pack'] });
		assert.deepEqual(r, { written: true, placed: ['alphas', 'betas'] });
		assert.deepEqual(readNavDoc(root).tree, [{ folder: 'Pack', items: ['alphas', 'betas'] }]);
		const before = readFile(root, 'nav.yaml');
		assert.match(before, /^# The left nav of this workspace\./);
		const again = applyNavFragments(root, { names: ['pack'] });
		assert.equal(again.written, false);
		assert.deepEqual(again.placed, []);
		assert.equal(readFile(root, 'nav.yaml'), before, 'byte-identical');
	});
	test('a fragment placing another module\'s collection refuses and writes nothing', () => {
		const root = fixture();
		applyNavFragments(root, { names: ['alpha'] });
		const before = readFile(root, 'nav.yaml');
		assert.throws(() => applyNavFragments(root, { names: ['rogue'] }),
			(e) => e instanceof NavFragmentRefusal && e.name === 'NavFragmentRefusal' && e.message === 'nav.yaml of rogue places betas, which beta owns');
		assert.equal(readFile(root, 'nav.yaml'), before);
	});
	test('every named fragment is judged before anything is merged', () => {
		const root = fixture();
		assert.throws(() => applyNavFragments(root, { names: ['alpha', 'rogue'] }), NavFragmentRefusal);
		assert.equal(readFile(root, 'nav.yaml'), null);
	});
	test('a namespace entry from the module that declares it is merged; from one that does not, refused', () => {
		const root = fixture();
		assert.equal(applyNavFragments(root, { names: ['nsmod'] }).written, true);
		assert.deepEqual(readNavDoc(root).tree, [{ namespace: 'fixns', items: ['fixns/items'] }]);
		const root2 = fixture();
		assert.throws(() => applyNavFragments(root2, { names: ['nsrogue'] }), /nav\.yaml of nsrogue places namespace fixns, which nsrogue does not declare/);
	});
	test('old nav settings and no nav.yaml skip the merge, unless ignoreSettings; an empty setting does not count', () => {
		const root = fixture();
		fs.mkdirSync(path.join(root, '.vscode'), { recursive: true });
		const settings = path.join(root, '.vscode', 'settings.json');
		fs.writeFileSync(settings, '{"dreamteamer.navOrder": ["alphas"]}');
		assert.deepEqual(applyNavFragments(root, { names: ['alpha'] }), { written: false, placed: [], skipped: 'settings' });
		assert.equal(readFile(root, 'nav.yaml'), null);
		assert.equal(navGuard(root), NAV_GUARD_LINE);
		assert.equal(applyNavFragments(root, { names: ['alpha'], ignoreSettings: true }).written, true);
		assert.equal(navGuard(root), null, 'nav.yaml exists now');
		fs.rmSync(path.join(root, 'nav.yaml'));
		fs.writeFileSync(settings, '{"dreamteamer.navOrder": []}');
		assert.equal(applyNavFragments(root, { names: ['alpha'] }).written, true);
	});
	test('navSettings reads JSONC and never counts layersFolder', () => {
		const root = fixture();
		fs.mkdirSync(path.join(root, '.vscode'), { recursive: true });
		const settings = path.join(root, '.vscode', 'settings.json');
		fs.writeFileSync(settings, '{\n  // a comment\n  "dreamteamer.layersFolder": "Layers", /* another, with a // inside */\n  "url": "http://x//y",\n}\n');
		assert.equal(navSettings(root), null);
		fs.writeFileSync(settings, '{\n  // the groups\n  "dreamteamer.navGroups": {"Work": ["alphas"]},\n  "dreamteamer.navHidden": [],\n}\n');
		assert.deepEqual(navSettings(root), ['dreamteamer.navGroups']);
		fs.writeFileSync(settings, '{ not json');
		assert.equal(navSettings(root), null);
	});
});
