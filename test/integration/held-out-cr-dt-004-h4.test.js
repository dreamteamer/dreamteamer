// held-out cr-dt-004-h4 — a scoped holder package name differing from its git_modules key; uninstalled
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkws, copyInto, clone, addLayer, coll, rec, NAME, manifest, dt, git } from './held-out-cr-dt-004-lib.js';

test('h4: from is the scoped package name; matched under any key; unreadable package.json changes nothing; lost → dangling; absent → external', () => {
	const COLLS = { people: coll('people', NAME), memos: coll('memos', { ...NAME, about: { type: 'people' } }) };
	const DANA = { 'data/people/dana.person.md': rec({ name: 'Dana' }) };
	const w = mkws({ colls: COLLS, files: { 'data/memos/n.memo.md': rec({ name: 'N', about: 'people/dana' }) }, layers: { people: { pkg: '@acme/people-hq', files: DANA } } });
	assert.equal(dt(w.root, 'exports').code, 0);
	assert.deepEqual(manifest(w.root), { people: { dana: { label: 'Dana', from: '@acme/people-hq' } } });
	const r = mkws({ pkg: 'r-ws', colls: COLLS });
	copyInto(r, w.root);
	const hq = clone(r.root, 'hq', { pkg: '@acme/people-hq', files: DANA });
	addLayer(r, 'hq', ['people']);
	const s2 = dt(r.root, 'check');
	assert.equal(s2.code, 0, s2.stdout); assert.doesNotMatch(s2.stdout, /stale|dangling|ℹ layer w/);
	assert.deepEqual(JSON.parse(dt(r.root, 'exports', '--layer', 'w', '--dry-run', '--json').stdout).manifests[0].changes, []);
	fs.chmodSync(path.join(hq, 'package.json'), 0o000);
	try { const s3 = dt(r.root, 'check'); assert.equal(s3.code, s2.code); assert.equal(s3.stdout, s2.stdout); } finally { fs.chmodSync(path.join(hq, 'package.json'), 0o644); }
	fs.rmSync(path.join(hq, 'data/people/dana.person.md')); git(hq, ['commit', '-qam', 'rm dana']);
	const s4 = dt(r.root, 'check');
	assert.match(s4.stdout, /dangling reference "people\/dana"/, s4.stdout);
	assert.match(s4.stdout, /git_modules\/w\/dreamteamer-exports\.json is stale — people\/dana \(drop: .*\)\. dt exports --layer w/);
	git(hq, ['revert', '--no-edit', 'HEAD']);
	fs.renameSync(hq, path.join(r.root, 'hq-away'));
	const s5 = dt(r.root, 'check');
	assert.match(s5.stdout, /layer hq .*not installed/);
	assert.match(s5.stdout, /^ℹ layer w: 1 reference to 1 record outside it.*people\/dana/m);
	assert.doesNotMatch(s5.stdout, /dangling/);
	assert.ok(!JSON.parse(dt(r.root, 'exports', '--layer', 'w', '--dry-run', '--json').stdout).manifests[0].changes.some((c) => c.kind === 'drop'));
	const r2 = mkws({ pkg: 'r2-ws', colls: COLLS });
	copyInto(r2, w.root);
	const s6 = dt(r2.root, 'check');
	assert.equal(s6.code, 0, s6.stdout); assert.match(s6.stdout, /ℹ layer w: .*people\/dana/);
	fs.rmSync(path.join(w.root, 'git_modules', 'people'), { recursive: true });
	const g = dt(w.root, 'get', 'people/dana');
	assert.equal(g.code, 1); assert.match(g.stderr, /"Dana"/); assert.match(g.stderr, /@acme\/people-hq/);
});
