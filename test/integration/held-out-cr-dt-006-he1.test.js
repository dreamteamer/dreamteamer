// held-out cr-dt-006-he1 — a dreamteamer.dependencies entry that exists (in the folder) but ships no
// dreamteamer key is refused before npm writes anything. rnd/tests/cr-dt-006-he1.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initialized, packInto, folder, dt, treeHash, cleanup, ENGINE, readPkg } from './held-out-cr-dt-006-lib.js';

after(cleanup);

test('he1: @fix/needs-plain → plain-pkg (no dreamteamer key): exit 1 naming the pair, nothing written, no npm', () => {
	const from = packInto(folder('reg'), [
		{ name: '@fix/needs-plain', version: '1.0.0', description: 'needs a plain package', dreamteamer: { description: 'held-out he1', dependencies: ['plain-pkg'] } },
		{ name: 'plain-pkg', version: '1.0.0', description: 'a valid npm package that is not a module', files: { 'index.js': 'module.exports = 1;\n' } },
	]);
	const root = initialized({ name: 'he1', spec: `file:${ENGINE}` });
	const before = { hash: treeHash(root), pkg: fs.readFileSync(path.join(root, 'package.json'), 'utf8'), lock: fs.existsSync(path.join(root, 'package-lock.json')) ? fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8') : null, mods: fs.readdirSync(path.join(root, 'node_modules')).sort() };
	const r = dt(root, ['install', '@fix/needs-plain', '--from', from]);
	assert.equal(r.code, 1, r.stdout + r.stderr);
	assert.match(r.stderr, /plain-pkg/, 'the package that is not a module is named');
	assert.match(r.stderr, /not a dreamteamer module/i, r.stderr);
	assert.match(r.stderr, /@fix\/needs-plain/, `the pair is named (the spec that asked for it): ${r.stderr}`);
	assert.equal(treeHash(root), before.hash, 'tree hash unchanged');
	assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), before.pkg);
	assert.equal(fs.existsSync(path.join(root, 'package-lock.json')) ? fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8') : null, before.lock);
	assert.deepEqual(fs.readdirSync(path.join(root, 'node_modules')).sort(), before.mods);
	assert.ok(!readPkg(root).dependencies['@fix/needs-plain'] && !readPkg(root).dependencies['plain-pkg']);
	assert.doesNotMatch(r.stderr + r.stdout, /ECONNREFUSED|ENOTFOUND|E404|registry/i, 'no registry was asked');
});
