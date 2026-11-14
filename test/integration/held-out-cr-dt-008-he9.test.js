// rnd/tests/dreamteamer/heldout-dt008-e-status-json-preset-fields — held-out, written by the test stage.
// dt status --json carries, for a module preset, that it is one and each member's pinned and installed
// version — so the absent and the drifted members — the same facts the text status prints.
//
// The fixture registry's @fix/set 1.1.0 pins THREE members (@fix/a 1.1.0, @fix/c 1.0.0, @fix/d 1.0.0 — the
// engine plan's fixture), where the record's premise names two; the counts below are the record's with d
// added ("3 members · 2 installed" for its "2 members · 1 installed").
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { offline, registry, run, out, npmUninstall } from './held-out-cr-dt-008-lib.js';

let REG;
before(() => { REG = registry(); });

const statusJson = (root) => {
	const r = run(root, ['status', '--json']);
	assert.equal(r.code, 0, out(r));
	let doc;
	assert.doesNotThrow(() => { doc = JSON.parse(r.stdout); }, `stdout is one JSON document and nothing else: ${r.stdout}`);
	return doc;
};
const member = (set, name) => set.members.find((m) => m.name === name);

describe('held-out he9 — dt status --json carries the preset fields', () => {
	test('steps 1-5', () => {
		const ws = offline();
		const i = run(ws.root, ['install', '@fix/set@1.1.0', '--from', REG]);
		assert.equal(i.code, 0, out(i));

		// step 2
		const j = statusJson(ws.root);
		assert.ok(Array.isArray(j.modules) && j.modules.length >= 5, JSON.stringify(j.modules));
		for (const m of j.modules) {
			assert.equal(typeof m.name, 'string', JSON.stringify(m));
			assert.ok('location' in m, `location kept: ${JSON.stringify(m)}`);
		}
		const set = j.modules.find((m) => m.name === '@fix/set');
		assert.equal(set.preset, true);
		assert.deepEqual(set.members, [
			{ name: '@fix/a', pinned: '1.1.0', installed: '1.1.0' },
			{ name: '@fix/c', pinned: '1.0.0', installed: '1.0.0' },
			{ name: '@fix/d', pinned: '1.0.0', installed: '1.0.0' },
		]);
		for (const m of j.modules.filter((m) => m.name !== '@fix/set')) assert.notEqual(m.preset, true, `${m.name} carries no preset: true`);

		// step 3
		npmUninstall(ws.root, '@fix/c');
		const c = run(ws.root, ['compile']);
		assert.equal(c.code, 0, out(c));
		const j3 = statusJson(ws.root);
		const set3 = j3.modules.find((m) => m.name === '@fix/set');
		assert.equal(member(set3, '@fix/c').installed, null, JSON.stringify(set3));
		assert.equal(member(set3, '@fix/c').pinned, '1.0.0');
		const t3 = run(ws.root, ['status']);
		assert.equal(t3.code, 0, out(t3));
		assert.match(t3.stdout, /@fix\/set\s+node_modules · preset · 3 members · 2 installed/, out(t3));
		assert.ok(t3.stdout.includes('@fix/c  not installed — dt install @fix/c'), out(t3));

		// step 4
		const u = run(ws.root, ['update', '@fix/a@1.0.0', '--from', REG, '--allow', 'downgrade']);
		assert.equal(u.code, 0, out(u));
		const set4 = statusJson(ws.root).modules.find((m) => m.name === '@fix/set');
		assert.deepEqual(member(set4, '@fix/a'), { name: '@fix/a', pinned: '1.1.0', installed: '1.0.0' });
		assert.equal(member(set4, '@fix/c').installed, null, 'still absent');
		const t4 = run(ws.root, ['status']);
		assert.equal(t4.code, 0, out(t4));
		assert.ok(t4.stdout.includes('@fix/a 1.0.0 (preset set names 1.1.0)'), out(t4));
		assert.ok(t4.stdout.includes('@fix/c  not installed — dt install @fix/c'), out(t4));

		// step 5
		const l = run(ws.root, ['list', 'modules', '--json']);
		assert.equal(l.code, 0, out(l));
		const row = JSON.parse(l.stdout).find((m) => (m.id ?? m.$id) === 'set');
		assert.equal(row?.preset, true, JSON.stringify(row));
		assert.deepEqual(row.members, ['modules/a', 'modules/c', 'modules/d']);
		const g = run(ws.root, ['get', 'modules/set', '--json']);
		assert.equal(g.code, 0, out(g));
		const rec = JSON.parse(g.stdout);
		assert.equal(rec.preset, true, g.stdout);
		assert.deepEqual(rec.members, ['modules/a', 'modules/c', 'modules/d'], 'members name c even with c absent');
		const ch = run(ws.root, ['check']);
		assert.doesNotMatch(ch.stdout + ch.stderr, /modules\/c/, `no dangling reference for the absent member: ${out(ch)}`);
		assert.doesNotMatch(ch.stdout + ch.stderr, /dangling|does not exist|unknown reference/i, out(ch));
	});
});
