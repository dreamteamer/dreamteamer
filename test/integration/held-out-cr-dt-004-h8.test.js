// held-out cr-dt-004-h8 — Store.external and dt get --referrer agree with dt check in a reader
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkws, copyInto, clone, addLayer, coll, rec, NAME, MANIFEST, dt, git, write } from './held-out-cr-dt-004-lib.js';
import { serializeExports } from '../../src/exports.ts';
import { Store } from '../../src/store.ts';

const ABOUT = { ...NAME, about: { type: 'people', many: true } };
const COLLS = { people: coll('people', NAME), users: coll('users', NAME), projects: coll('projects', ABOUT), 'ns/notes': coll('ns/notes', ABOUT), tasks: coll('tasks', ABOUT) };
const WM = { people: { x: { label: 'Ex', from: 'l-ws' }, y: { label: 'Why', from: 'h-ws' }, z: { label: 'Zed', from: 'l-ws' } } };

function reader({ hFor = ['users'] } = {}) {
	const w = mkws({ pkg: 'w-ws', colls: COLLS, namespaces: ['ns'], files: {
		'data/projects/p.project.md': rec({ name: 'P', about: ['people/x'] }), 'data/projects/q.project.md': rec({ name: 'Q', about: ['people/z'] }),
		'data/ns/notes/a/b.note.md': rec({ name: 'AB', about: ['people/y'] }), [MANIFEST]: serializeExports(WM) } });
	const r = mkws({ pkg: 'r-ws', colls: COLLS, namespaces: ['ns'], files: { 'data/tasks/t.task.md': rec({ name: 'T', about: ['people/x'] }) } });
	copyInto(r, w.root);
	clone(r.root, 'h', { pkg: 'h-ws', files: { 'data/users/u.user.md': rec({ name: 'U' }) } });
	addLayer(r, 'h', hFor);
	return r;
}

test('h8: parity with check; never the layer\'s manifest for an own referrer; namespaced nested referrer; D5; removed clone; refusals', () => {
	const r = reader();
	const ck = dt(r.root, 'check');
	assert.match(ck.stdout, /^ℹ layer w: 3 references to 3 records outside it.*\(people\/x, people\/y, people\/z\)$/m, ck.stdout);
	assert.match(ck.stdout, /dangling reference "people\/x"/, 'R\'s own tasks/t: R has no manifest');
	const s = new Store(r.ws);
	const man = `git_modules/w/${MANIFEST}`;
	assert.deepEqual(s.external('people', 'x', { referrer: 'projects/p' }), { label: 'Ex', from: 'l-ws', manifest: man });
	assert.deepEqual(s.external('people', 'z', { referrer: 'projects/q' }), { label: 'Zed', from: 'l-ws', manifest: man });
	assert.deepEqual(s.external('people', 'y', { referrer: 'ns/notes/a/b' }), { label: 'Why', from: 'h-ws', manifest: man });
	assert.equal(s.external('people', 'x', { referrer: 'tasks/t' }), null);
	const g3 = dt(r.root, 'get', 'people/x', '--referrer', 'tasks/t');
	assert.equal(g3.code, 1); assert.doesNotMatch(g3.stderr, /external/);
	const g4 = dt(r.root, 'get', 'people/y', '--referrer', 'ns/notes/a/b', '--json');
	assert.equal(g4.code, 1);
	assert.deepEqual(JSON.parse(g4.stdout).$external, { collection: 'people', id: 'y', label: 'Why', from: 'h-ws', manifest: man });
	// R reads H for people too; H lacks y → dangling, stale, and external answers null
	addLayer(r, 'h', ['users', 'people']);
	const ck5 = dt(r.root, 'check');
	assert.match(ck5.stdout, /dangling reference "people\/y"/); assert.match(ck5.stdout, /is stale — .*people\/y/);
	assert.equal(new Store(r.ws).external('people', 'y', { referrer: 'ns/notes/a/b' }), null);
	// W's clone removed after compile
	fs.renameSync(path.join(r.root, 'git_modules', 'w'), path.join(r.root, 'w-away'));
	const ck6 = dt(r.root, 'check');
	assert.throws(() => new Store(r.ws).external('people', 'x', { referrer: 'projects/p' }), /projects\/p/);
	assert.match(ck6.stdout, /not installed/);
	fs.renameSync(path.join(r.root, 'w-away'), path.join(r.root, 'git_modules', 'w'));
	assert.throws(() => new Store(r.ws).external('people', 'x', { referrer: 'projects/nope' }), /projects\/nope/);
	const g7 = dt(r.root, 'get', 'people/x', '--referrer', 'projects/nope');
	assert.notEqual(g7.code, 0); assert.match(g7.stderr, /projects\/nope/);
	const g8 = dt(r.root, 'get', 'people/x', '--referrer', 'people/x');
	assert.notEqual(g8.code, 0); assert.match(g8.stderr, /people\/x: no such record here/);
});
