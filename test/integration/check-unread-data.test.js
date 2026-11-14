// `dt check` names record files under the workspace's own data/ that no compiled collection reads (cr-dt-008
// test stage, held-out hm8): a folder of `<id>.<suffix>.<ext>` files whose collection left with a module
// (notebooks and wikis out of rnd) is a ⚠ line naming the folder, its records and, when a package here
// defines it, that package — never a violation, so the exit code is unchanged.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, simpleCollection } from '../helpers/ws.js';

const put = (root, rel, text = '---\nname: x\n---\n') => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };

describe('dt check — record files no collection reads', () => {
	test('a folder of records whose collection is not installed: one warning naming the folder and the records; exit 0', () => {
		const ws = workspace({ namespaces: ['lab'], collections: { alphas: simpleCollection(), 'lab/betas': simpleCollection() } });
		ws.dt('add', 'alphas', '--name', 'one');
		put(ws.root, 'data/notebooks/northwind-research.notebook.md');
		put(ws.root, 'data/notebooks/2026/q3-plan.notebook.md');
		put(ws.root, 'data/lab/gammas/g1.gamma.md');
		const r = ws.dt('check');
		assert.equal(r.code, 0, r.stdout + r.stderr);
		assert.match(r.stdout, /⚠ data\/notebooks\/ — 2 record files no collection here reads \(2026\/q3-plan\.notebook\.md, northwind-research\.notebook\.md\) — install the module that defines it/);
		assert.match(r.stdout, /⚠ data\/lab\/gammas\/ — 1 record file no collection here reads \(g1\.gamma\.md\)/);
		assert.match(r.stdout, /✔ 0 violations/);
		assert.doesNotMatch(r.stdout, /data\/alphas|data\/lab\/betas/);
	});
	test('files that are not records, and a claimed folder, say nothing', () => {
		const ws = workspace({ collections: { alphas: simpleCollection() } });
		put(ws.root, 'data/scratch/notes.txt', 'x');
		put(ws.root, 'data/scratch/readme.md', 'x');
		const r = ws.dt('check');
		assert.equal(r.code, 0, r.stdout + r.stderr);
		assert.doesNotMatch(r.stdout, /no collection here reads/);
	});
	test('a package here that defines the collection but is not compiled is named', () => {
		const ws = workspace({ collections: { alphas: simpleCollection() } });
		put(ws.root, 'node_modules/@fix/nb/package.json', JSON.stringify({ name: '@fix/nb', version: '1.0.0', dreamteamer: {} }));
		put(ws.root, 'node_modules/@fix/nb/collections/notebooks.collection.yaml', 'name: notebooks\nfields:\n  name: { type: string }\n');
		put(ws.root, 'data/notebooks/northwind-research.notebook.md');
		const r = ws.dt('check');
		assert.equal(r.code, 0, r.stdout + r.stderr);
		assert.match(r.stdout, /⚠ data\/notebooks\/ — 1 record file no collection here reads \(northwind-research\.notebook\.md\) — @fix\/nb defines notebooks: dt install @fix\/nb/);
	});
});
