// held-out cr-dt-004-h2 — references spelled bare; many-valued and nested reference fields
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkws, coll, rec, NAME, MANIFEST, count, dt, git, write } from './held-out-cr-dt-004-lib.js';

test('h2: the manifest lists exactly what check counted; never a mis-parsed key; a second dt exports changes nothing', () => {
	const COLLS = { people: coll('people', NAME), memos: coll('memos', { ...NAME, owner: { type: 'people' }, cc: { type: 'people', many: true }, meta: { type: 'object', fields: { contact: { type: 'people' } } } }) };
	const w = mkws({ colls: COLLS, layers: { l: { pkg: 'l-ws', files: { 'data/people/dana.person.md': rec({ name: 'Dana' }), 'data/people/eli.person.md': rec({ name: 'Eli' }) } } } });
	const add = dt(w.root, 'add', 'memos', '--name', 'n1', '--owner', 'dana', '--cc', 'dana', '--cc', 'eli');
	write(w.root, { 'data/memos/n2.memo.md': rec({ name: 'n2', owner: 'dana', cc: ['eli'], meta: { contact: 'eli' } }) });
	git(w.root, ['add', '-A']); git(w.root, ['commit', '-qm', 'notes']);
	const before = dt(w.root, 'check');
	const warned = new Set([...before.stdout.matchAll(/^⚠ (\S+) resolves only through layer/gm)].map((m) => m[1]));
	assert.equal(dt(w.root, 'exports').code, 0);
	const refs = fs.existsSync(path.join(w.root, MANIFEST)) ? JSON.parse(fs.readFileSync(path.join(w.root, MANIFEST), 'utf8')).references : {};
	for (const k of Object.keys(refs)) assert.ok(!['dana', 'eli', 'meta'].includes(k), `mis-parsed key ${k}`);
	const listed = new Set(Object.entries(refs).flatMap(([c, ids]) => Object.keys(ids).map((id) => `${c}/${id}`)));
	assert.deepEqual([...listed].sort(), [...warned].sort(), `check counted ${[...warned]} (add exit ${add.code}: ${add.stderr})`);
	const after = dt(w.root, 'check');
	assert.doesNotMatch(after.stdout, /is stale/);
	for (const id of listed) assert.doesNotMatch(after.stdout, new RegExp(`^⚠ ${id} resolves only`, 'm'));
	const n = count(w.root); const bytes = fs.existsSync(path.join(w.root, MANIFEST)) ? fs.readFileSync(path.join(w.root, MANIFEST), 'utf8') : null;
	assert.equal(dt(w.root, 'exports').code, 0);
	assert.equal(count(w.root), n);
	assert.equal(fs.existsSync(path.join(w.root, MANIFEST)) ? fs.readFileSync(path.join(w.root, MANIFEST), 'utf8') : null, bytes);
});
