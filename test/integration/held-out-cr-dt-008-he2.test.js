// rnd/tests/dreamteamer/heldout-dt008-e-member-downgrade-under-a-preset — held-out, written by the test stage.
// `dt update <member>@<lower>` is a downgrade that needs --allow downgrade even when a module preset pins
// the higher version; dt status then names the drift, and a no-op preset update never re-pins it.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { offline, registry, run, out, pinOf, installed, readFile, snapshot } from './held-out-cr-dt-008-lib.js';

let REG;
before(() => { REG = registry(); });

describe('held-out he2 — a member downgrade under a module preset', () => {
	test('steps 1-5: refused without the flag, allowed with it, status names the drift, a no-op preset update leaves it', () => {
		const ws = offline();
		const i = run(ws.root, ['install', '@fix/set@1.1.0', '--from', REG]);
		assert.equal(i.code, 0, out(i));
		assert.equal(installed(ws.root, '@fix/a'), '1.1.0');

		// step 2
		const pkg = readFile(ws.root, 'package.json');
		const r2 = run(ws.root, ['update', '@fix/a@1.0.0', '--from', REG]);
		assert.equal(r2.code, 1, out(r2));
		assert.ok(r2.stderr.includes('is a downgrade — say so: dt update @fix/a@1.0.0 --allow downgrade'), out(r2));
		assert.equal(readFile(ws.root, 'package.json'), pkg, 'package.json byte-identical');

		// step 3
		const r3 = run(ws.root, ['update', '@fix/a@1.0.0', '--from', REG, '--allow', 'downgrade']);
		assert.equal(r3.code, 0, out(r3));
		assert.equal(pinOf(ws.root, '@fix/a'), '1.0.0');
		assert.equal(installed(ws.root, '@fix/a'), '1.0.0');
		assert.equal(pinOf(ws.root, '@fix/set'), '1.1.0');
		assert.equal(installed(ws.root, '@fix/set'), '1.1.0');

		// step 4
		const s = run(ws.root, ['status']);
		assert.equal(s.code, 0, out(s));
		assert.ok(s.stdout.includes('@fix/a 1.0.0 (preset set names 1.1.0)'), out(s));
		const c = run(ws.root, ['compile']);
		assert.equal(c.code, 0, out(c));
		assert.doesNotMatch(c.stderr + c.stdout, /✖|error/i, 'a drifted member is no compile failure');

		// step 5
		const r5 = run(ws.root, ['update', '@fix/set@1.1.0', '--from', REG]);
		assert.ok(r5.stdout.includes('already 1.1.0 — nothing to do') || r5.stderr.includes('already 1.1.0 — nothing to do'), out(r5));
		assert.equal(pinOf(ws.root, '@fix/a'), '1.0.0', 'the drifted member is not silently re-pinned');
		assert.equal(installed(ws.root, '@fix/a'), '1.0.0');
	});

	test('step 6: a preset whose pin is below an installed member refuses, naming the versions and dt update, writing nothing', () => {
		const ws = offline();
		const i = run(ws.root, ['install', '@fix/a@1.1.0', '--from', REG]);
		assert.equal(i.code, 0, out(i));
		const before = snapshot(ws.root);
		const r = run(ws.root, ['install', '@fix/set@1.0.0', '--from', REG]);
		assert.equal(r.code, 1, out(r));
		assert.ok(r.stderr.includes('installed at 1.1.0, not 1.0.0'), out(r));
		assert.ok(r.stderr.includes('dt update'), out(r));
		assert.deepEqual(snapshot(ws.root), before, 'nothing written');
	});
});
