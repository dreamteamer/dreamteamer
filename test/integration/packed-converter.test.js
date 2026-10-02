// Tier 2 — the converter as a stranger gets it (review R5): pack the engine, install the tarball's bytes
// into a workspace the way npm lays them out, and run the converter by the path its usage line gives,
// `node node_modules/dreamteamer/scripts/migrate-descriptors-v2.mjs`, then compile with the PACKED engine.
// A file that exists only in a developer's checkout fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { workspace, writeCollection, ENGINE_ROOT, WS_MODULE } from '../helpers/ws.js';
import { load } from '../../src/yaml.js';

const run = (cwd, args) => spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 60_000 });

test('the packed engine ships the converter, and it converts a v1 workspace that the packed engine then compiles', () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-pack-'));
	try {
		execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', tmp, '--cache', path.join(tmp, 'cache')], { cwd: ENGINE_ROOT, stdio: 'ignore', timeout: 120_000 });
		const tgz = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'));
		assert.ok(tgz, 'npm pack produced a tarball');
		execFileSync('tar', ['-xzf', path.join(tmp, tgz), '-C', tmp], { timeout: 60_000 });

		const w = workspace({ compile: false });
		writeCollection(w.root, 'companies', {
			description: 'An organisation.',
			id: { generate: '{{ name | slug }}' },
			schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, notes: { type: 'string', format: 'markdown', 'x-body': true } } },
			list_fields: ['name', 'last-modified'],
		});
		// the tarball's bytes in place of the checkout link, its dependencies hoisted beside it as npm does
		const nm = path.join(w.root, 'node_modules');
		fs.rmSync(path.join(nm, 'dreamteamer'), { recursive: true, force: true });
		fs.cpSync(path.join(tmp, 'package'), path.join(nm, 'dreamteamer'), { recursive: true });
		for (const dep of fs.readdirSync(path.join(ENGINE_ROOT, 'node_modules'))) {
			if (dep.startsWith('.') || fs.existsSync(path.join(nm, dep))) continue;
			fs.symlinkSync(path.join(ENGINE_ROOT, 'node_modules', dep), path.join(nm, dep));
		}

		const conv = run(w.root, ['node_modules/dreamteamer/scripts/migrate-descriptors-v2.mjs', '--root', '.']);
		assert.equal(conv.status, 0, conv.stderr);
		assert.match(conv.stdout, /migrated: descriptors \d+/);
		const src = load(fs.readFileSync(path.join(w.root, 'modules', WS_MODULE, 'collections', 'companies.collection.yaml'), 'utf8'));
		assert.ok('fields' in src, 'the descriptor is v2');

		const bin = path.join(nm, 'dreamteamer', 'bin', 'dreamteamer.js');
		const compile = run(w.root, [bin, 'compile']);
		assert.equal(compile.status, 0, compile.stdout + compile.stderr);
		const check = run(w.root, [bin, 'check']);
		assert.equal(check.status, 0, check.stdout + check.stderr);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});
