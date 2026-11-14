// rnd/tests/dreamteamer/heldout-dt008-e-fragment-label-at-a-nested-level — held-out, written by the test stage.
// A fragment folder merges into a same-label folder only at the same level: a hand-made folder of that
// label nested elsewhere is not reused, and the hand edits survive byte for byte.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { offline, registry, run, out, readFile, git, lastFiles, collection } from './held-out-cr-dt-008-lib.js';
import { readNavDoc, parseNavDoc, placedNames, mergeFragment } from '../../src/nav.js';

let REG;
before(() => { REG = registry([{ name: '@fix/extra', version: '1.0.0', dreamteamer: { description: 'a plain module with no fragment' }, files: { 'collections/fixextras.collection.yaml': collection('fixextras') } }]); });

const HAND = '# my own nav — hand written, keep this line first\ntree:\n  - folder: Mine\n    items:\n      - fixds\n      - folder: Fixtures\n        items: []\nhidden: []\n';
const MINE = { folder: 'Mine', items: ['fixds', { folder: 'Fixtures', items: [] }] };

describe('held-out he4 — a fragment folder is reused only at the same level', () => {
	test('steps 1-5: a new top-level Fixtures is appended; Mine and its nested empty Fixtures are untouched; re-installs change nothing', () => {
		const ws = offline();
		const d = run(ws.root, ['install', '@fix/d@1.0.0', '--from', REG]);
		assert.equal(d.code, 0, out(d));
		assert.equal(readFile(ws.root, 'nav.yaml'), null, '@fix/d ships no fragment');

		fs.writeFileSync(path.join(ws.root, 'nav.yaml'), HAND);
		git(ws.root, ['add', 'nav.yaml']);
		git(ws.root, ['commit', '-qm', 'hand nav']);

		const s = run(ws.root, ['install', '@fix/set@1.0.0', '--from', REG]);
		assert.equal(s.code, 0, out(s));
		const text = readFile(ws.root, 'nav.yaml');
		const doc = readNavDoc(ws.root);
		assert.deepEqual(doc.tree, [MINE, { folder: 'Fixtures', items: ['fixas', 'fixcs'] }], text);
		assert.deepEqual(doc.hidden, [], 'hidden unchanged');
		const all = JSON.stringify(doc.tree);
		assert.equal(all.split('"fixas"').length - 1, 1, 'fixas once');
		assert.equal(all.split('"fixcs"').length - 1, 1, 'fixcs once');
		const first = text.split('\n')[0];
		assert.ok(first === HAND.split('\n')[0] || first === '# The left nav of this workspace. Drag and drop writes this file; so may you.', `first line: ${first}`);
		assert.ok(lastFiles(ws.root).includes('nav.yaml'), `nav.yaml is in the install commit: ${lastFiles(ws.root)}`);
		assert.equal(git(ws.root, ['status', '--porcelain', '--', 'nav.yaml']), '');

		// step 5
		const navLog = git(ws.root, ['log', '--format=%H', '--', 'nav.yaml']);
		const again = run(ws.root, ['install', '@fix/set@1.0.0', '--from', REG]);
		assert.equal(again.code, 0, out(again));
		assert.equal(readFile(ws.root, 'nav.yaml'), text, 'byte-identical after re-install');
		const other = run(ws.root, ['install', '@fix/extra', '--from', REG]);
		assert.equal(other.code, 0, out(other));
		assert.equal(readFile(ws.root, 'nav.yaml'), text, 'byte-identical after a no-fragment install');
		assert.ok(!lastFiles(ws.root).includes('nav.yaml'), lastFiles(ws.root).join(','));
		assert.equal(git(ws.root, ['log', '--format=%H', '--', 'nav.yaml']), navLog, 'no commit for nav.yaml');
		assert.equal(git(ws.root, ['status', '--porcelain', '--', 'nav.yaml']), '');
	});

	test('step 6: mergeFragment places [fixas, fixcs] once; a second merge returns the same object', () => {
		const doc = parseNavDoc(HAND);
		const fragment = parseNavDoc('tree:\n  - folder: Fixtures\n    items: [fixas, fixcs]\n');
		const r = mergeFragment(doc, fragment, { placed: placedNames(doc) });
		assert.deepEqual(r.placedNow, ['fixas', 'fixcs']);
		assert.deepEqual(r.doc.tree, [MINE, { folder: 'Fixtures', items: ['fixas', 'fixcs'] }]);
		assert.deepEqual(doc.tree, [MINE], 'the input is not mutated');
		const r2 = mergeFragment(r.doc, fragment, { placed: placedNames(r.doc) });
		assert.equal(r2.doc, r.doc, 'the same doc object (===)');
		assert.deepEqual(r2.placedNow, []);
	});
});
