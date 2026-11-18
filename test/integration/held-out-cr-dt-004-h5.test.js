// held-out cr-dt-004-h5 — completeness at run time: a pulled folder, and a collection skipped by descriptor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkws, copyInto, coll, rec, NAME, MANIFEST, count, dt, git, write } from './held-out-cr-dt-004-lib.js';
import { serializeExports } from '../../src/exports.ts';

const X = { people: { x: { label: 'X', from: 'far' } } };

test('h5 A: an uninstalled collection\'s folder appearing by pull makes the layer incomplete without a recompile', () => {
	const W = { people: coll('people', NAME), memos: coll('memos', { ...NAME, about: { type: 'people' } }) };
	const w = mkws({ colls: W, files: { 'data/people/p1.person.md': rec({ name: 'P1' }), [MANIFEST]: serializeExports(X) } });
	const r = mkws({ pkg: 'r-ws', colls: { people: coll('people', NAME) } });
	const wd = copyInto(r, w.root);
	assert.match(dt(r.root, 'check').stdout, /people\/x \(drop: no record references it\)/);
	assert.ok(JSON.parse(dt(r.root, 'exports', '--layer', 'w', '--dry-run', '--json').stdout).manifests[0].changes.some((c) => c.kind === 'drop'));
	write(wd, { 'data/memos/n1.memo.md': rec({ name: 'N1', about: 'people/x' }) }); git(wd, ['add', '-A']); git(wd, ['commit', '-qm', 'n1']);
	const n = count(wd); const bytes = fs.readFileSync(path.join(wd, MANIFEST), 'utf8');
	assert.doesNotMatch(dt(r.root, 'check').stdout, /people\/x \(drop/);
	assert.ok(!JSON.parse(dt(r.root, 'exports', '--layer', 'w', '--dry-run', '--json').stdout).manifests[0].changes.some((c) => c.kind === 'drop'));
	dt(r.root, 'exports', '--layer', 'w');
	assert.equal(count(wd), n); assert.equal(fs.readFileSync(path.join(wd, MANIFEST), 'utf8'), bytes);
	write(w.root, { 'data/memos/n1.memo.md': rec({ name: 'N1', about: 'people/x' }) });
	assert.equal(dt(w.root, 'check').code, 0);
});

test('h5 B: a collection the reader skips by descriptor (env-pointed) leaves the layer incomplete even before its first file', () => {
	const annex = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dt-h5-')));
	const W = { people: coll('people', NAME), tasks: coll('tasks', { ...NAME, about: { type: 'people' } }) };
	const w = mkws({ colls: W, files: { 'data/people/p1.person.md': rec({ name: 'P1' }), [MANIFEST]: serializeExports(X) } });
	const R = { people: coll('people', NAME), tasks: coll('tasks', { ...NAME, about: { type: 'people' } }, { path: '${env:TASKS_HOME}/tasks' }) };
	const r = mkws({ pkg: 'r-ws', colls: R, vars: ['TASKS_HOME'], env: `TASKS_HOME=${annex}\n` });
	const wd = copyInto(r, w.root);
	assert.doesNotMatch(dt(r.root, 'check').stdout, /people\/x \(drop/, 'tasks is skipped for the layer by descriptor');
	assert.ok(!JSON.parse(dt(r.root, 'exports', '--layer', 'w', '--dry-run', '--json').stdout).manifests[0].changes.some((c) => c.kind === 'drop'));
	write(wd, { 'data/tasks/t1.task.md': rec({ name: 'T1', about: 'people/x' }) }); git(wd, ['add', '-A']); git(wd, ['commit', '-qm', 't1']);
	const n = count(wd); const bytes = fs.readFileSync(path.join(wd, MANIFEST), 'utf8');
	assert.doesNotMatch(dt(r.root, 'check').stdout, /people\/x \(drop/);
	dt(r.root, 'exports', '--layer', 'w');
	assert.equal(count(wd), n); assert.equal(fs.readFileSync(path.join(wd, MANIFEST), 'utf8'), bytes);
	write(w.root, { 'data/tasks/t1.task.md': rec({ name: 'T1', about: 'people/x' }) });
	assert.equal(dt(w.root, 'check').code, 0);
});
