// held-out cr-dt-006-he5 — status on a workspace whose .dreamteamer/setup/<unit>/ holds a receipt for a
// unit that was since uninstalled. rnd/tests/cr-dt-006-he5.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initialized, installPackage, folder, dt, treeHash, cleanup, ENGINE_ROOT, readPkg, writePkg } from './held-out-cr-dt-006-lib.js';

after(cleanup);

test('he5: an orphan receipt is never evidence — no ready · verified, no crash, nothing deleted or rewritten', () => {
	const root = initialized({ name: 'he5' });
	installPackage(root, path.join(ENGINE_ROOT, 'test', 'fixtures', 'probe-setup'));
	assert.equal(dt(root, ['compile']).code, 0);
	const home = folder('probe-home');
	const tok = path.join(folder('tok'), 'token'); fs.writeFileSync(tok, 'x', { mode: 0o600 }); fs.chmodSync(tok, 0o600);   // owner-only: the engine refuses a secret-path others can read (D56; amended 2026-11-13 by the operator's decision)
	const env = { PROBE_TOKEN_PATH: tok };
	const v = dt(root, ['setup', 'probe', '--input', 'label=x', '--input', `home=${home}`, '--verify', '--allow', 'machine', '--allow', 'download'], env);
	assert.equal(v.code, 0, v.stderr + v.stdout);
	assert.match(v.stdout, /ready · verified/);
	const receipt = path.join(root, '.dreamteamer', 'setup', 'probe', 'verify.json');
	assert.ok(fs.existsSync(receipt), 'the receipt was written');
	const bytes = fs.readFileSync(receipt);
	// the uninstall, as npm would leave it: the package gone from node_modules and from package.json
	fs.rmSync(path.join(root, 'node_modules', '@probe', 'setup'), { recursive: true, force: true });
	const pkg = readPkg(root); delete pkg.dependencies['@probe/setup']; writePkg(root, pkg);
	assert.equal(dt(root, ['compile']).code, 0);
	assert.ok(fs.existsSync(receipt), 'compile leaves the orphan receipt alone');
	for (const args of [['status'], ['status', '--json'], ['doctor'], ['doctor', '--json']]) {
		const before = treeHash(root);
		const r = dt(root, args, env);
		assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}`);
		assert.doesNotMatch(r.stdout, /probe.*ready · verified|ready · verified.*probe/, `${args.join(' ')}: the receipt alone is never evidence\n${r.stdout}`);
		assert.doesNotMatch(r.stderr, /TypeError|ENOENT|at .*\.js:\d+/, `${args.join(' ')} crashed: ${r.stderr}`);
		assert.equal(treeHash(root), before, `${args.join(' ')} wrote nothing`);
	}
	assert.ok(fs.existsSync(receipt) && fs.readFileSync(receipt).equals(bytes), 'status/doctor neither delete nor rewrite the orphan receipt');
});
