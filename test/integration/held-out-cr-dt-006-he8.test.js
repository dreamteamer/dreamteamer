// held-out cr-dt-006-he8 — two inputs sharing one env key are ONE input (D39): filled once by the one
// declared default; two different values in one call are a usage refusal naming both; declarations that
// disagree on kind are a compile refusal. rnd/tests/cr-dt-006-he8. `dt setup` with no unit drives every
// installed unit in one call (the design's `setup [<unit>]` takes at most one).
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initialized, setupPackage, installPackage, applyLog, folder, dt, treeHash, cleanup } from './held-out-cr-dt-006-lib.js';

after(cleanup);
const pair = () => {
	const root = initialized({ name: 'he8' });
	installPackage(root, setupPackage({ name: '@heldout/a', unit: 'a', vars: ['PROBE_HOME'], inputs: [{ id: 'home', kind: 'path', env: 'PROBE_HOME', required: true, default: '~/.cache/a', title: 'home' }] }));
	installPackage(root, setupPackage({ name: '@heldout/b', unit: 'b', vars: ['PROBE_HOME'], homeInput: 'base', inputs: [{ id: 'base', kind: 'path', env: 'PROBE_HOME', required: true, title: 'base' }] }));
	const c = dt(root, ['compile']); assert.equal(c.code, 0, c.stderr);
	return root;
};
const count = (text, key) => (text.match(new RegExp(`^${key}=`, 'gm')) ?? []).length;

describe('he8: one env key, two inputs', () => {
	test('step 2 — PROBE_HOME unset, no flag: the one declared default fills BOTH units, .env gains the key once, no needs', () => {
		const root = pair();
		const r = dt(root, ['setup', '--no-input', '--json']);
		assert.equal(r.code, 0, `exit ${r.code}\n${r.stdout}${r.stderr}`);
		const j = JSON.parse(r.stdout);
		for (const u of j.units) assert.deepEqual(u.needs, [], `${u.id} needs nothing: ${JSON.stringify(u.needs)}`);
		const env = fs.readFileSync(path.join(root, '.env'), 'utf8');
		assert.equal(count(env, 'PROBE_HOME'), 1, `.env holds PROBE_HOME once:\n${env}`);
		const a = applyLog(root, 'a');
		assert.match(a[0]?.inputs.home ?? '', /\/\.cache\/a$/, 'a applied with the default');
		// b had nothing left to apply once a wrote the key and made the folder: its needs are empty and it is ready (above)
		assert.match(env, /PROBE_HOME=.*\/\.cache\/a$/m, 'the value is the one declared default');
	});
	test('step 3 — one flag for one of them fills both; .env written once', () => {
		const root = pair();
		const home = path.join(folder('home'), 'shared');
		const r = dt(root, ['setup', '--input', `home=${home}`, '--no-input', '--json']);
		assert.equal(r.code, 0, r.stdout + r.stderr);
		const j = JSON.parse(r.stdout);
		for (const u of j.units) { assert.deepEqual(u.needs, [], `${u.id} needs nothing`); assert.equal(u.state, 'ready', `${u.id} is ready`); }
		const a = applyLog(root, 'a');
		assert.equal(a[0]?.inputs.home, home);
		// b's base was filled with the same value: its home check reads configured against that folder, and it had nothing to apply
		const env = fs.readFileSync(path.join(root, '.env'), 'utf8');
		assert.equal(count(env, 'PROBE_HOME'), 1);
		assert.match(env, new RegExp(`^PROBE_HOME=${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
	});
	test('step 4 — two different values for one env key in one call: exit 2 naming a.home, b.base and the key; nothing written', () => {
		const root = pair();
		const before = treeHash(root);
		const r = dt(root, ['setup', '--input', `a.home=${folder('one')}`, '--input', `b.base=${folder('two')}`, '--no-input']);
		assert.equal(r.code, 2, `a usage refusal (exit 2): exit ${r.code}\n${r.stdout}${r.stderr}`);
		assert.match(r.stderr, /a\.home/); assert.match(r.stderr, /b\.base/); assert.match(r.stderr, /PROBE_HOME/);
		assert.equal(treeHash(root), before, 'nothing written');
		assert.ok(!fs.existsSync(path.join(root, '.env')));
	});
	test('step 5 — declarations that disagree on kind for one env key are a compile refusal naming the pair and the key', () => {
		const root = initialized({ name: 'he8-kind' });
		installPackage(root, setupPackage({ name: '@heldout/c', unit: 'c', vars: ['PROBE_HOME'], inputs: [{ id: 'home', kind: 'path', env: 'PROBE_HOME', required: true, default: '~/.cache/c', title: 'home' }] }));
		installPackage(root, setupPackage({ name: '@heldout/d', unit: 'd', vars: ['PROBE_HOME'], inputs: [{ id: 'home', kind: 'string', env: 'PROBE_HOME', required: true, title: 'home' }] }));
		const c = dt(root, ['compile']);
		assert.equal(c.code, 1, `compile refuses: exit ${c.code}\n${c.stdout}${c.stderr}`);
		assert.match(c.stderr, /PROBE_HOME/); assert.match(c.stderr, /\bc\b.*\bd\b|\bd\b.*\bc\b|@heldout\/c.*@heldout\/d|@heldout\/d.*@heldout\/c/s, 'names the pair');
	});
});
