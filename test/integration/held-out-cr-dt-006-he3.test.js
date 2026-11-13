// held-out cr-dt-006-he3 — two specs in one call where the second's closure resolves the first's name at another
// version. D52 (2026-11-13): dreamteamer.dependencies is a PRESENCE graph, so the explicit pin in the call wins —
// b@1.0.0 and a install together, exit 0, one b, the pinned one; nothing is resolved twice. (The record first read
// this as a refusal; the test asserts the decision.) rnd/tests/cr-dt-006-he3.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initialized, packInto, folder, dt, cleanup, ENGINE, readPkg, git } from './held-out-cr-dt-006-lib.js';

after(cleanup);

test('he3 (D52): install @fix/b@1.0.0 @fix/a (a → b, latest in the folder 2.0.0) keeps the pin: b 1.0.0 and a installed, exit 0, one b, committed', () => {
	const from = packInto(folder('reg'), [
		{ name: '@fix/b', version: '1.0.0', description: 'b 1', dreamteamer: { description: 'b' } },
		{ name: '@fix/b', version: '2.0.0', description: 'b 2', dreamteamer: { description: 'b' } },
		{ name: '@fix/a', version: '1.0.0', description: 'a', dreamteamer: { description: 'a', dependencies: ['@fix/b'] } },
	]);
	const root = initialized({ name: 'he3', spec: `file:${ENGINE}` });
	const r = dt(root, ['install', '@fix/b@1.0.0', '@fix/a', '--from', from]);
	assert.equal(r.code, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /install: @fix\/b@1\.0\.0, @fix\/a@1\.0\.0/, 'the install list names the pinned b once, dependencies first');
	assert.doesNotMatch(r.stdout, /@fix\/b@2\.0\.0/, 'the folder\'s newer b is not pulled in beside the pin');
	const deps = readPkg(root).dependencies;
	assert.ok(deps['@fix/b'] && deps['@fix/a'], `both declared: ${JSON.stringify(deps)}`);
	// (with --from, npm saves the tarball as a file: spec — noted on the record, not this test's question)
	assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'node_modules', '@fix', 'b', 'package.json'), 'utf8')).version, '1.0.0', 'one b on disk, the pinned one');
	assert.ok(fs.existsSync(path.join(root, '.dreamteamer', 'collections', 'as.collection.yaml')), 'compiled with a');
	assert.match(git(root, ['log', '-1', '--format=%s']), /^dreamteamer: install @fix\/b, @fix\/a$/);
	assert.equal(git(root, ['status', '--porcelain']), '', 'one scoped commit, nothing left');
});
