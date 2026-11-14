// rnd/tests/dreamteamer/heldout-dt008-e-fragment-namespace-entry — held-out, written by the test stage (with
// the record's round-2 amendment: fixtures @fix/lab and @fix/lab-thief; reuse at the SAME level only; the
// thief refused on install and update alike).
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { offline, registry, run, out, readFile, git, snapshot, collection, commitAll, installed } from './held-out-cr-dt-008-lib.js';
import { readNavDoc } from '../../src/nav.js';

const lab = (version, names, navItems) => ({
	name: '@fix/lab', version,
	dreamteamer: { description: 'a module declaring namespace lab', namespaces: ['lab'], nav: 'nav.yaml' },
	files: {
		...Object.fromEntries(names.map((n) => [`collections/lab/${n}.collection.yaml`, collection(`lab/${n}`)])),
		'nav.yaml': navItems,
	},
});
const LAB_NAV = 'tree:\n  - namespace: lab\n    items:\n      - lab/alphas\n      - folder: Inner\n        items: [lab/betas]\n';
const LAB_NAV_11 = 'tree:\n  - namespace: lab\n    items:\n      - lab/alphas\n      - folder: Inner\n        items: [lab/betas]\n      - lab/gammas\n';
const THIEF_LINE = 'nav.yaml of @fix/lab-thief places namespace lab, which @fix/lab-thief does not declare';

let REG;
before(() => {
	REG = registry([
		lab('1.0.0', ['alphas', 'betas'], LAB_NAV),
		lab('1.1.0', ['alphas', 'betas', 'gammas'], LAB_NAV_11),
		{ name: '@fix/lab-thief', version: '0.9.0', dreamteamer: { description: 'the thief before it shipped a fragment', dependencies: ['@fix/lab'] }, files: { 'collections/thieves.collection.yaml': collection('thieves') } },
		{ name: '@fix/lab-thief', version: '1.0.0', dreamteamer: { description: 'a plain module naming lab in its fragment', dependencies: ['@fix/lab'], nav: 'nav.yaml' }, files: { 'collections/thieves.collection.yaml': collection('thieves'), 'nav.yaml': 'tree:\n  - namespace: lab\n    items: [thieves]\n' } },
	]);
});

const LAB_ENTRY = { namespace: 'lab', items: ['lab/alphas', { folder: 'Inner', items: ['lab/betas'] }] };
/** Every namespace entry for `ns`, at any depth. */
const entriesOf = (tree, ns, acc = []) => { for (const e of tree ?? []) { if (e && typeof e === 'object') { if (e.namespace === ns) acc.push(e); entriesOf(e.items, ns, acc); } } return acc; };
const handNav = (root, text) => { fs.writeFileSync(path.join(root, 'nav.yaml'), text); git(root, ['add', 'nav.yaml']); git(root, ['commit', '-qm', 'hand nav']); };

describe('held-out he5 — a fragment that opens with a namespace entry', () => {
	test('step 2 and step 4: installs into one namespace entry; an update adds the new row inside it and moves nothing', () => {
		const ws = offline();
		const r = run(ws.root, ['install', '@fix/lab@1.0.0', '--from', REG]);
		assert.equal(r.code, 0, out(r));
		assert.doesNotMatch(r.stderr, /places lab|which .* owns/);
		assert.deepEqual(readNavDoc(ws.root), { tree: [LAB_ENTRY], hidden: [] });

		// step 4: lab/alphas moved by hand to the top level
		handNav(ws.root, 'tree:\n  - lab/alphas\n  - namespace: lab\n    items:\n      - folder: Inner\n        items: [lab/betas]\n');
		const u = run(ws.root, ['update', '@fix/lab@1.1.0', '--from', REG]);
		assert.equal(u.code, 0, out(u));
		const doc = readNavDoc(ws.root);
		assert.deepEqual(doc.tree, ['lab/alphas', { namespace: 'lab', items: [{ folder: 'Inner', items: ['lab/betas'] }, 'lab/gammas'] }], readFile(ws.root, 'nav.yaml'));
		assert.equal(entriesOf(doc.tree, 'lab').length, 1, 'exactly one namespace: lab entry');
	});

	test('step 3: a namespace entry nested in a folder is not reused at the top level — nav.yaml byte-identical', () => {
		const ws = offline();
		handNav(ws.root, 'tree:\n  - folder: Top\n    items:\n      - namespace: lab\n');
		const text = readFile(ws.root, 'nav.yaml');
		const r = run(ws.root, ['install', '@fix/lab@1.0.0', '--from', REG]);
		assert.equal(r.code, 0, out(r));
		assert.equal(readFile(ws.root, 'nav.yaml'), text, 'byte-identical');
		const doc = readNavDoc(ws.root);
		assert.equal(entriesOf(doc.tree, 'lab').length, 1, 'no second namespace: lab entry');
		assert.deepEqual(doc.tree, [{ folder: 'Top', items: [{ namespace: 'lab' }] }], 'nothing added at the top level; alphas and betas stay unplaced');
	});

	test('step 3b: a top-level namespace entry with no items is the one filled', () => {
		const ws = offline();
		handNav(ws.root, 'tree:\n  - namespace: lab\n');
		const r = run(ws.root, ['install', '@fix/lab@1.0.0', '--from', REG]);
		assert.equal(r.code, 0, out(r));
		assert.deepEqual(readNavDoc(ws.root).tree, [LAB_ENTRY]);
	});

	test('step 5: the thief\'s fragment naming lab is refused on install and on update alike, nothing changed', () => {
		const ws = offline();
		const l = run(ws.root, ['install', '@fix/lab@1.0.0', '--from', REG]);
		assert.equal(l.code, 0, out(l));
		const before = snapshot(ws.root);
		const t = run(ws.root, ['install', '@fix/lab-thief@1.0.0', '--from', REG]);
		assert.equal(t.code, 1, out(t));
		assert.ok(t.stderr.includes(THIEF_LINE), out(t));
		const after = snapshot(ws.root);
		assert.equal(after.pkg, before.pkg, 'package.json byte-identical');
		assert.equal(after.lock, before.lock, 'package-lock.json byte-identical');
		assert.equal(after.nav, before.nav, 'nav.yaml byte-identical');
		assert.equal(entriesOf(readNavDoc(ws.root).tree, 'lab').length, 1);

		// the update path: the thief at a version with no fragment, then updated to the one with it
		const t9 = run(ws.root, ['install', '@fix/lab-thief@0.9.0', '--from', REG]);
		assert.equal(t9.code, 0, out(t9));
		const before2 = snapshot(ws.root);
		const u = run(ws.root, ['update', '@fix/lab-thief@1.0.0', '--from', REG]);
		assert.equal(u.code, 1, out(u));
		assert.ok(u.stderr.includes(THIEF_LINE), out(u));
		const after2 = snapshot(ws.root);
		assert.equal(after2.pkg, before2.pkg, 'package.json byte-identical after the refused update');
		assert.equal(after2.lock, before2.lock, 'package-lock.json byte-identical after the refused update');
		assert.equal(after2.nav, before2.nav);
		assert.equal(installed(ws.root, '@fix/lab-thief'), '0.9.0');
	});
});
