// rnd/tests/dreamteamer/heldout-dt008-e-member-pin-absent-from-the-registry — held-out, written by the test
// stage. A module preset one of whose member pins does not exist in the registry is refused before npm
// writes, naming the member and the missing version, and leaves nothing half-written.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { offline, registry, run, out, snapshot, installed, pinOf } from './held-out-cr-dt-008-lib.js';

let REG;
before(() => {
	REG = registry([
		{ name: '@fix/broken-set', version: '1.0.0', dreamteamer: { description: 'a pin that does not exist', preset: { '@fix/a': '1.0.0', '@fix/c': '9.9.9' }, nav: 'nav.yaml' }, files: { 'nav.yaml': 'tree:\n  - folder: Broken\n    items: [fixas, fixcs]\n' } },
		{ name: '@fix/gone-set', version: '1.0.0', dreamteamer: { description: 'a package that does not exist', preset: { '@fix/nowhere': '1.0.0' } }, pkgFiles: [] },
		{ name: '@fix/deep-set', version: '1.0.0', dreamteamer: { description: 'a preset of a broken preset', preset: { '@fix/broken-set': '1.0.0' } }, pkgFiles: [] },
		{ name: '@fix/set', version: '1.2.0', dreamteamer: { description: 'a newer preset whose pin is absent', preset: { '@fix/a': '7.7.7', '@fix/c': '1.0.0' } }, pkgFiles: [] },
	]);
});

const refusedCleanly = (r, before, after, names) => {
	assert.equal(r.code, 1, out(r));
	assert.doesNotMatch(r.stdout, /▶ npm/, `npm was never started: ${out(r)}`);
	for (const n of names) assert.ok(r.stderr.includes(n), `stderr names ${n}: ${out(r)}`);
	assert.doesNotMatch(r.stderr, /^npm (ERR!|error)|ETARGET|E404/m, 'not npm\'s raw output');
	assert.deepEqual(after, before, 'package.json, lock, node_modules/@fix, nav.yaml, git status and HEAD identical');
};

describe('held-out he8 — a member pin absent from the registry', () => {
	test('steps 2-3 and 5: three refusals before npm, nothing written; then a healthy install, no resume state', () => {
		const ws = offline();
		const before = snapshot(ws.root);
		for (const [target, names] of [['@fix/broken-set', ['@fix/c', '9.9.9']], ['@fix/gone-set', ['@fix/nowhere']], ['@fix/deep-set', ['@fix/c', '9.9.9']]]) {
			const r = run(ws.root, ['install', target, '--from', REG]);
			refusedCleanly(r, before, snapshot(ws.root), names);
			assert.equal(installed(ws.root, '@fix/a'), null, `${target}: @fix/a, which resolved fine, is NOT installed`);
			assert.equal(snapshot(ws.root).nav, null, 'no nav.yaml');
			if (target === '@fix/deep-set') {
				// ideally with the path through broken-set — reported, never required
				if (!r.stderr.includes('@fix/broken-set')) console.log('# note: deep-set refusal does not name the path through @fix/broken-set');
			}
		}
		const ok = run(ws.root, ['install', '@fix/a', '--from', REG]);
		assert.equal(ok.code, 0, out(ok));
		assert.doesNotMatch(ok.stdout + ok.stderr, /run the same command again to resume/);
		assert.equal(installed(ws.root, '@fix/a'), '1.1.0');
	});

	test('step 4: dt update to a preset version whose pin is absent refuses the same way; nothing moves', () => {
		const ws = offline();
		const i = run(ws.root, ['install', '@fix/set@1.0.0', '--from', REG]);
		assert.equal(i.code, 0, out(i));
		const before = snapshot(ws.root);
		const r = run(ws.root, ['update', '@fix/set@1.2.0', '--from', REG]);
		refusedCleanly(r, before, snapshot(ws.root), ['@fix/a', '7.7.7']);
		assert.equal(installed(ws.root, '@fix/set'), '1.0.0');
		assert.equal(pinOf(ws.root, '@fix/set'), '1.0.0');
		assert.equal(installed(ws.root, '@fix/a'), '1.0.0', '@fix/a stays put');
	});
});
