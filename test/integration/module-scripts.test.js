// Tier 2 — the module-script escape valve, proven end to end on its worked example.
//
// Three claims, each load-bearing for references/module-scripts.md:
//   1. a module carrying a script COMPILES — the skill folder shape with extra files is legal,
//      and its dot-prefixed .cache/ never reaches the compiled skill copy;
//   2. the script runs against the workspace's pinned engine and answers in refs;
//   3. `--where` means what it means on `dt list`, because it IS the engine's matchesFilter.
//
// Skips (never fails) where node:sqlite is missing — the script's own refusal covers that case,
// and package.json still supports Node 20.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { workspace, ENGINE_ROOT } from '../helpers/ws.js';
import { compile } from '../../src/compile.js';

const hasSqlite = await import('node:sqlite').then(() => true, () => false);

const NOTES = {
	id: { generate: '{{ title | slug }}' },
	storage: { suffix: 'note' },
	schema: {
		type: 'object', required: ['title'],
		properties: {
			title: { type: 'string' },
			status: { type: 'string' },
			body: { type: 'string', format: 'markdown', 'x-body': true },
		},
	},
};

function fixture() {
	const fx = workspace({
		collections: { notes: NOTES },
		records: {
			notes: [
				{ title: 'Acme review', status: 'open', body: 'the client was visibly frustrated and hinted at churn' },
				{ title: 'Globex demo', status: 'done', body: 'the client was delighted and asked about expanding scope' },
				{ title: 'Weekly sync', status: 'open', body: 'routine agenda, nothing notable' },
			],
		},
	});
	fs.cpSync(path.join(ENGINE_ROOT, 'examples', 'modules', 'search'), path.join(fx.root, 'modules', 'search'), { recursive: true });
	return fx;
}

const SCRIPT = ['modules', 'search', 'skills', 'vault-search', 'find.mjs'];
const run = (root, ...a) => spawnSync(process.execPath, [path.join(root, ...SCRIPT), ...a], { cwd: root, encoding: 'utf8' });

describe('module scripts — the search example', { skip: hasSqlite ? false : 'node:sqlite unavailable on this Node' }, () => {
	test('a module carrying a script compiles, and .cache/ stays out of the compiled skill', () => {
		const { root, ws } = fixture();
		compile(ws);
		const compiled = path.join(root, '.claude', 'skills', 'vault-search');
		assert.ok(fs.existsSync(path.join(compiled, 'SKILL.md')), 'skill compiled into the harness');
		assert.ok(fs.existsSync(path.join(compiled, 'find.mjs')), 'the script travels with the folder');
		// run once so .cache/ exists at the source, then recompile: the dot-dir must not be copied
		assert.equal(run(root, 'churn').status, 0);
		compile(ws);
		assert.ok(fs.existsSync(path.join(root, ...SCRIPT.slice(0, -1), '.cache')), 'cache exists at the source');
		assert.ok(!fs.existsSync(path.join(compiled, '.cache')), 'cache never reaches the compiled copy');
	});

	test('search answers in refs, ranked, cross-collection input not required', () => {
		const { root, ws } = fixture();
		compile(ws);
		const r = run(root, 'churn');
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, /^notes\/acme-review\t/m);
		assert.doesNotMatch(r.stdout, /globex-demo/);
	});

	test('--where is the engine operator set — typed filter over full-text hits', () => {
		const { root, ws } = fixture();
		compile(ws);
		const hit = run(root, 'client', '--where', '{"status":"open"}', '--json');
		assert.equal(hit.status, 0, hit.stderr);
		const rows = JSON.parse(hit.stdout);
		assert.deepEqual(rows.map((x) => x.ref), ['notes/acme-review']);
	});

	test('no hits exits 1 with a message, and every invocation lands in the usage log', () => {
		const { root, ws } = fixture();
		compile(ws);
		assert.equal(run(root, 'zebra-quantum').status, 1);
		run(root, 'churn');
		const log = fs.readFileSync(path.join(root, ...SCRIPT.slice(0, -1), '.cache', 'usage.log'), 'utf8').trim().split('\n');
		assert.equal(log.length, 2);
		assert.equal(JSON.parse(log[1]).query, 'churn');
	});
});
