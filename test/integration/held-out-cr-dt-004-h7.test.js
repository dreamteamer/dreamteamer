// held-out cr-dt-004-h7 — the migration over namespaced, title-less, binary-adjacent and not-fully-read stubs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkws, copyInto, coll, rec, NAME, MANIFEST, manifest, head, count, dt, git } from './held-out-cr-dt-004-lib.js';
import { migrate } from '../../scripts/migrate-stubs.mjs';

const BASE = {
	people: coll('people', NAME), 'ns/things': coll('ns/things', NAME),
	docs: coll('docs', { name: { type: 'string' }, file: { type: 'string' } }),
	images: 'name: images\nstorage:\n  suffix: image\n  format: binary\nfields: {}\n',
	memos: coll('memos', { ...NAME, who: { type: 'people' }, thing: { type: 'ns/things' }, doc: { type: 'docs' }, pic: { type: 'images' } }),
};
const STUB = (fields, body = 'A private body.\n') => rec({ ...fields, stub: true, secret: 'extra-value' }, body);

test('h7: dry run writes nothing; the run yields live labels, one namespaced key, a title-less id label, a kept unseen entry; every check clean', () => {
	const w = mkws({ pkg: 'w-ws', colls: { ...BASE, journal: coll('journal', { ...NAME, about: { type: 'people' } }) }, namespaces: ['ns'], files: {
		'data/people/dana.person.md': STUB({ name: 'Dana (stub)' }),
		'data/ns/things/box.thing.md': STUB({ name: 'Box (stub)' }),
		'data/docs/spec.doc.md': STUB({ file: 'files/spec.bin' }),
		'data/people/eli.person.md': STUB({ name: 'Eli (stub)' }),
		'data/memos/n1.memo.md': rec({ name: 'N1', who: 'people/dana', thing: 'ns/things/box', doc: 'docs/spec', pic: 'images/logo' }),
		'data/journal/j1.journal.md': rec({ name: 'J1', about: 'people/eli' }),
		'data/images/logo.image.png': 'png-bytes',
	} });
	const h = mkws({ pkg: 'h-hq', colls: BASE, namespaces: ['ns'], files: { 'data/people/dana.person.md': rec({ name: 'Dana' }), 'data/ns/things/box.thing.md': rec({ name: 'Box' }) } });
	const wd = copyInto(h, w.root);
	const logo = fs.readFileSync(path.join(wd, 'data/images/logo.image.png'));
	const before = [head(h.root), head(wd)];
	const lines = [];
	migrate(h.root, { layers: true, dryRun: true, log: (l) => lines.push(l) });
	assert.deepEqual([head(h.root), head(wd)], before);
	assert.equal(git(wd, ['status', '--porcelain']).trim(), '');
	const out = lines.join('\n');
	for (const ref of ['people/dana', 'ns/things/box', 'docs/spec', 'people/eli']) assert.match(out, new RegExp(ref.replace(/\//g, '\\/')));
	assert.match(out, /named by memos\/n1/);
	const n = count(wd);
	migrate(h.root, { layers: true, log: () => {} });
	assert.throws(() => git(wd, ['grep', '-l', '^stub: true', '--', 'data']));
	assert.deepEqual(fs.readFileSync(path.join(wd, 'data/images/logo.image.png')), logo);
	const m = manifest(wd);
	assert.deepEqual(m.people.dana, { label: 'Dana', from: 'h-hq' });
	assert.deepEqual(m['ns/things'], { box: { label: 'Box', from: 'h-hq' } });
	assert.equal(m.ns, undefined);
	assert.deepEqual(m.docs, { spec: { label: 'spec' } });
	assert.deepEqual(m.people.eli, { label: 'Eli (stub)' });
	const raw = fs.readFileSync(path.join(wd, MANIFEST), 'utf8');
	assert.doesNotMatch(raw, /private body|extra-value/);
	assert.equal(Number(count(wd)), Number(n) + 1);
	assert.deepEqual(git(wd, ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').sort(), [MANIFEST, 'data/docs/spec.doc.md', 'data/ns/things/box.thing.md', 'data/people/dana.person.md', 'data/people/eli.person.md'].sort());
	const hc = dt(h.root, 'check');
	assert.equal(hc.code, 0, hc.stdout); assert.doesNotMatch(hc.stdout, /dangling/);
	// W alone, on the dev engine: its migrated tree in a workspace with its own collections
	const alone = mkws({ pkg: 'w-ws', colls: { ...BASE, journal: coll('journal', { ...NAME, about: { type: 'people' } }) }, namespaces: ['ns'] });
	fs.rmSync(path.join(alone.root, 'data'), { recursive: true, force: true });
	fs.cpSync(path.join(wd, 'data'), path.join(alone.root, 'data'), { recursive: true });
	fs.cpSync(path.join(wd, MANIFEST), path.join(alone.root, MANIFEST));
	const ac = dt(alone.root, 'check');
	assert.equal(ac.code, 0, ac.stdout);
	assert.match(ac.stdout, /^ℹ 4 references to 4 records outside this workspace/m);
	assert.doesNotMatch(ac.stdout, /unknown field "stub"|dangling/);
});
