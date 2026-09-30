// The PUBLIC API is a contract with other repos, so it is pinned three ways: the runtime export list
// equals the typed declaration, importing it has no side effect, and an INSTALLED copy exposes it
// while hiding `src/*` — a source-tree import passing proves nothing about what npm ships.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { workspace, git, ENGINE_ROOT } from '../helpers/ws.js';
import { resolveNpm, childEnv } from '../../src/checkout.js';

const dts = (f) => fs.readFileSync(path.join(ENGINE_ROOT, 'src', f), 'utf8');

/** Every runtime name a declaration file declares: `export function|const|class X`, and the comma
 *  lists. `api.d.ts` re-exports `records-api.d.ts`, so its set is the union. */
function declared(file) {
	const text = dts(file);
	const names = new Set();
	for (const m of text.matchAll(/^export (?:declare )?(?:function|class|const) ([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
	for (const m of text.matchAll(/^export const ([^;]+);/gm)) {
		for (const part of m[1].split(/,\s*/)) { const n = /^([A-Za-z_$][\w$]*)\s*:/.exec(part.trim()); if (n) names.add(n[1]); }
	}
	if (/^export \* from '\.\/records-api\.js';/m.test(text)) for (const n of declared('records-api.d.ts')) names.add(n);
	return names;
}

/** The static import closure of one src/ module: every src file reached, and every bare specifier. */
function closure(entry) {
	const files = new Set(), bare = new Set();
	const visit = (f) => {
		if (files.has(f)) return;
		files.add(f);
		const body = fs.readFileSync(path.join(ENGINE_ROOT, 'src', f), 'utf8');
		for (const m of body.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+'([^']+)'|import\(\s*'([^']+)'/g)) {
			const spec = m[1] ?? m[2];
			if (spec.startsWith('./')) visit(spec.slice(2)); else bare.add(spec);
		}
	};
	visit(entry);
	return { files, bare };
}

describe('dreamteamer (the public API)', () => {
	test('the runtime exports are exactly the declared ones — for both entries', async () => {
		for (const [mod, file, floor] of [['../../src/api.js', 'api.d.ts', 60], ['../../src/records-api.js', 'records-api.d.ts', 30]]) {
			const runtime = new Set(Object.keys(await import(mod)));
			const types = declared(file);
			assert.ok(types.size > floor, `the declaration parse found only ${types.size} names — the pattern no longer matches ${file}`);
			assert.deepEqual([...runtime].filter((n) => !types.has(n)).sort(), [], `exported but not declared in ${file}`);
			assert.deepEqual([...types].filter((n) => !runtime.has(n)).sort(), [], `declared in ${file} but not exported`);
		}
	});

	// ⚠ NAMES ARE NOT ENOUGH — the SHAPE is the contract too. `KNOWN_OPERATORS` was declared an array
	// while the runtime value is a Set, so strict TypeScript accepted `.includes('_eq')` and it threw
	// at run time (review F8). Every declared value is checked against the kind its type names.
	test('every declared export has the runtime SHAPE its type says', async () => {
		for (const [mod, file] of [['../../src/api.js', 'api.d.ts'], ['../../src/records-api.js', 'records-api.d.ts']]) {
			const api = await import(mod);
			const text = dts(file);
			for (const m of text.matchAll(/^export (?:declare )?(?:function|class) ([A-Za-z_$][\w$]*)/gm)) {
				assert.equal(typeof api[m[1]], 'function', `${file}: ${m[1]} is declared a function/class, runtime is ${typeof api[m[1]]}`);
			}
			for (const m of text.matchAll(/^export const (.+);$/gm)) {
				for (const part of m[1].split(/,\s*(?=[A-Za-z_$][\w$]*\s*:\s*[A-Z'\d(r])/)) {
					const [, name, type] = /^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/.exec(part.trim()) ?? [];
					if (!name) continue;
					const v = api[name];
					if (/^ReadonlySet</.test(type)) assert.ok(v instanceof Set, `${name}: declared ReadonlySet, runtime is not a Set`);
					else if (/^readonly .*\[\]$/.test(type)) assert.ok(Array.isArray(v), `${name}: declared an array, runtime is not one`);
					else if (type === 'string') assert.equal(typeof v, 'string', name);
					else if (/^'.*'$/.test(type)) assert.equal(v, type.slice(1, -1), name);
					else if (/^\d+$/.test(type)) assert.equal(v, Number(type), name);
					else if (type === 'SchemaOp') assert.equal(typeof v, 'function', name);
					else assert.fail(`${file}: ${name}: no shape rule for the declared type "${type}" — add one here`);
				}
			}
		}
		const { KNOWN_OPERATORS } = await import('../../src/records-api.js');
		assert.equal(KNOWN_OPERATORS.has('_eq'), true);
	});

	// ⚠ THE BROWSER CONSTRAINT. The mobile app runs `dreamteamer/records` in a browser with shims for
	// exactly three node builtins. A record-half import that reached the compiler, the extension
	// loader or the CLI would pull `node:url`/`node:crypto`/`node:os` in at import time and the app
	// would die on load — the one failure its own tests cannot see until a bundle is built.
	test('dreamteamer/records reaches only the record half and three node builtins', () => {
		const { files, bare } = closure('records-api.js');
		for (const f of ['compile.js', 'cli.js', 'extensions.js', 'checkout.js', 'init.js', 'harnesses.js', 'schema-ops.js', 'api.js', 'env-vars.js']) {
			assert.ok(!files.has(f), `records-api.js reaches ${f}`);
		}
		const builtins = [...bare].filter((b) => b.startsWith('node:')).sort();
		assert.deepEqual(builtins, ['node:child_process', 'node:fs', 'node:path']);
	});

	test('importing it prints nothing, writes nothing, and binds nothing', () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-api-'));
		const url = new URL('../../src/api.js', import.meta.url).href;
		const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)}); console.log('HANDLES', process._getActiveHandles().length)`], { cwd, encoding: 'utf8', timeout: 30_000 });
		assert.equal(r.status, 0, r.stderr);
		assert.equal(r.stderr, '');
		assert.equal(r.stdout.trim(), 'HANDLES 0');
		assert.deepEqual(fs.readdirSync(cwd), [], 'importing the API wrote into the cwd');
	});

	test('openWorkspace returns the handle with its (empty) extensions, and changes no cwd', async () => {
		const { openWorkspace } = await import('../../src/api.js');
		const ws = workspace();
		const before = process.cwd();
		const handle = await openWorkspace(ws.root);
		assert.equal(handle.root, ws.root);
		assert.deepEqual(handle.extensions, []);
		assert.equal(process.cwd(), before);
	});
});

describe('the INSTALLED package', () => {
	test('`import "dreamteamer"` resolves to the API, and `dreamteamer/src/*` is not reachable', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-pack-'));
		// pack exactly what `files` publishes, then install that tarball — never the source tree
		// npm resolved the way `dt install` resolves it — beside the running node first, PATH second — and
		// a failure reported with npm's own words: the review saw this step fail in a copied tree with
		// nothing but "Command failed" to go on.
		const npm = resolveNpm();
		assert.ok(npm, 'no npm beside this node or on PATH — the packed-install check cannot run');
		const pack = spawnSync(npm, ['pack', '--silent', '--pack-destination', dir], { cwd: ENGINE_ROOT, encoding: 'utf8', timeout: 120_000, env: childEnv() });
		assert.equal(pack.status, 0, `npm pack failed (status ${pack.status}${pack.error ? `, ${pack.error.message}` : ''}):\n${pack.stderr}${pack.stdout}`);
		const tgz = pack.stdout.trim().split('\n').pop();
		fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
		const inst = spawnSync(npm, ['install', '--no-audit', '--no-fund', '--prefer-offline', path.join(dir, tgz)], { cwd: dir, encoding: 'utf8', timeout: 300_000 });
		assert.equal(inst.status, 0, `npm install of the tarball failed (status ${inst.status}${inst.error ? `, ${inst.error.message}` : ''}):\n${inst.stderr}`);
		// the core install is LEAN: no HTTP framework, no optional tool
		const installed = fs.readdirSync(path.join(dir, 'node_modules'));
		assert.ok(!installed.includes('express'), 'express is still in the core dependency tree');
		const pub = spawnSync(process.execPath, ['-e', "import('dreamteamer').then((m) => console.log(m.apiVersion, typeof m.openWorkspace, typeof m.Store))"], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
		assert.equal(pub.stdout.trim(), '1 function function', pub.stderr);
		const rec = spawnSync(process.execPath, ['-e', "import('dreamteamer/records').then((m) => console.log(m.apiVersion, typeof m.Store, typeof m.openWorkspace))"], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
		assert.equal(rec.stdout.trim(), '1 function undefined', rec.stderr);
		const deep = spawnSync(process.execPath, ['-e', "import('dreamteamer/src/store.js').then(() => console.log('REACHED'), (e) => console.log(e.code))"], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
		assert.equal(deep.stdout.trim(), 'ERR_PACKAGE_PATH_NOT_EXPORTED');
		// and the extracted tools are NOT in the tarball
		const listing = execFileSync('tar', ['-tzf', path.join(dir, tgz)], { encoding: 'utf8' });
		for (const gone of ['src/server.js', 'src/prove.js', 'src/land.js', 'src/containers.js', 'src/container-archive.js', 'src/export-notebooklm.js']) {
			assert.ok(!listing.includes(`package/${gone}`), `${gone} is still published`);
		}
		assert.ok(listing.includes('package/src/api.d.ts') && listing.includes('package/src/records-api.d.ts'), 'the type declarations are not published');
	});
});

describe('dt init commits only what it wrote', () => {
	test('unrelated staged and unstaged work in an existing repo is left exactly as it was', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-init-'));
		git(dir, ['init', '-q']);
		git(dir, ['config', 'user.email', 'test@example.invalid']); git(dir, ['config', 'user.name', 'dreamteamer test']);
		fs.writeFileSync(path.join(dir, 'staged.txt'), 'mine, staged\n');
		fs.writeFileSync(path.join(dir, 'loose.txt'), 'mine, untracked\n');
		git(dir, ['add', 'staged.txt']);
		const bin = fileURLToPath(new URL('../../bin/dreamteamer.js', import.meta.url));
		const r = spawnSync(process.execPath, [bin, 'init'], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
		assert.equal(r.status, 0, r.stderr);
		const committed = git(dir, ['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean);
		assert.ok(committed.includes('package.json') && committed.includes('.gitignore'), committed.join(', '));
		assert.ok(!committed.includes('staged.txt'), 'init swept an unrelated STAGED file into its commit');
		assert.ok(!committed.includes('loose.txt'), 'init swept an unrelated untracked file into its commit');
		const status = git(dir, ['status', '--porcelain']);
		assert.match(status, /^A {2}staged\.txt$/m, 'the operator\'s staged file is no longer staged');
		assert.match(status, /^\?\? loose\.txt$/m);
	});
});
