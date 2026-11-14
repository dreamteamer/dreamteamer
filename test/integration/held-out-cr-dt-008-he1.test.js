// rnd/tests/dreamteamer/heldout-dt008-e-nested-preset-and-ring — held-out, written by the test stage.
// A module preset whose member is itself a preset installs the whole nested set at its pins; a ring
// through presets (two packages, or one naming itself) is refused before npm writes.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { offline, registry, run, out, pinOf, installed, treeHash } from './held-out-cr-dt-008-lib.js';

let REG;
before(() => {
	REG = registry([
		{ name: '@fix/outer', version: '1.0.0', dreamteamer: { description: 'nested preset', preset: { '@fix/set': '1.0.0', '@fix/d': '1.0.0' } }, pkgFiles: [] },
		{ name: '@fix/loop-x', version: '1.0.0', dreamteamer: { description: 'ring x', preset: { '@fix/loop-y': '1.0.0' } }, pkgFiles: [] },
		{ name: '@fix/loop-y', version: '1.0.0', dreamteamer: { description: 'ring y', preset: { '@fix/loop-x': '1.0.0' } }, pkgFiles: [] },
		{ name: '@fix/self', version: '1.0.0', dreamteamer: { description: 'self ring', preset: { '@fix/self': '1.0.0' } }, pkgFiles: [] },
	]);
});

describe('held-out he1 — a nested module preset and a ring through presets', () => {
	test('step 2-3: @fix/outer installs every member of the nested set, each pinned directly', () => {
		const ws = offline();
		const r = run(ws.root, ['install', '@fix/outer', '--from', REG]);
		assert.equal(r.code, 0, out(r));
		const deps = JSON.parse(fs.readFileSync(path.join(ws.root, 'package.json'), 'utf8')).dependencies;
		const want = { '@fix/outer': '1.0.0', '@fix/set': '1.0.0', '@fix/d': '1.0.0', '@fix/a': '1.0.0', '@fix/b': '1.0.0', '@fix/c': '1.0.0' };
		for (const [name, v] of Object.entries(want)) {
			assert.ok(name in deps, `${name} is a direct dependency: ${JSON.stringify(deps)}`);
			assert.equal(pinOf(ws.root, name), v, `${name} pinned exactly at ${v}`);
			assert.equal(installed(ws.root, name), v, `${name} installed at ${v}`);
		}

		const list = run(ws.root, ['list', 'modules', '--json']);
		assert.equal(list.code, 0, out(list));
		const rows = JSON.parse(list.stdout);
		const row = (id) => rows.find((m) => (m.id ?? m.$id) === id);
		const outer = row('outer'), set = row('set');
		assert.ok(outer && set, `rows for outer and set: ${JSON.stringify(rows.map((m) => m.id ?? m.$id))}`);
		assert.equal(outer.preset, true);
		assert.equal(set.preset, true);
		assert.deepEqual([...outer.members].sort(), ['modules/d', 'modules/set']);
		assert.deepEqual([...set.members].sort(), ['modules/a', 'modules/c']);
		assert.equal(outer.preset_summary, 'preset · 2 members · 2 installed');
		assert.equal(set.preset_summary, 'preset · 2 members · 2 installed');
		for (const id of ['a', 'b', 'c', 'd']) assert.notEqual(row(id)?.preset, true, `${id} is no preset`);

		const text = run(ws.root, ['list', 'modules']);
		assert.equal(text.code, 0, out(text));
		assert.match(text.stdout, /^outer\s+preset · 2 members · 2 installed/m);
		assert.match(text.stdout, /^set\s+preset · 2 members · 2 installed/m);

		const s = run(ws.root, ['status']);
		assert.equal(s.code, 0, out(s));
		assert.match(s.stdout, /@fix\/outer\s+node_modules · preset · 2 members · 2 installed/);
		assert.match(s.stdout, /@fix\/set\s+node_modules · preset · 2 members · 2 installed/);
		assert.doesNotMatch(s.stdout, /not installed — dt install/);

		const compiled = fs.readdirSync(path.join(ws.root, '.dreamteamer', 'collections')).filter((f) => /^fix|^outer|^set|^loop/.test(f)).sort();
		assert.deepEqual(compiled, ['fixas.collection.yaml', 'fixbs.collection.yaml', 'fixcs.collection.yaml', 'fixds.collection.yaml']);
		// nothing a preset shipped: neither preset package holds a source folder
		for (const p of ['@fix/outer', '@fix/set']) {
			const shipped = fs.readdirSync(path.join(ws.root, 'node_modules', p)).filter((f) => !['package.json', 'nav.yaml', 'README.md'].includes(f));
			assert.deepEqual(shipped, [], `${p} shipped nothing`);
		}
	});

	for (const [label, target, names] of [['step 4: a ring through two presets', '@fix/loop-x', ['@fix/loop-x', '@fix/loop-y']], ['step 5: a preset naming itself', '@fix/self', ['@fix/self']]]) {
		test(`${label} is refused before npm, naming the ring, writing nothing`, () => {
			const ws = offline();
			const before = treeHash(ws.root);
			const r = run(ws.root, ['install', target, '--from', REG]);
			assert.equal(r.code, 1, out(r));
			assert.equal(r.signal ?? null, null, 'no timeout');
			assert.doesNotMatch(r.stdout, /▶ npm/, 'npm never started');
			assert.match(r.stderr, /ring in dreamteamer\.dependencies or preset:/, out(r));
			for (const n of names) assert.ok(r.stderr.includes(n), `names ${n}: ${r.stderr}`);
			assert.doesNotMatch(r.stderr + r.stdout, /Maximum call stack|RangeError/);
			assert.equal(treeHash(ws.root), before, 'nothing written');
			assert.equal(fs.existsSync(path.join(ws.root, 'nav.yaml')), false);
		});
	}
});
