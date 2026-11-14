// rnd/tests/dreamteamer/heldout-dt008-e-settings-jsonc-with-only-layersfolder — held-out, written by the test
// stage. A .vscode/settings.json in JSONC carrying only dreamteamer.layersFolder (and a commented-out navOrder)
// neither refuses an install nor skips the merge; a real nav key does refuse; an unparseable file is not
// "settings present"; empty values agree with dt-nav migrate; update refuses the same way and --allow
// nav-reset reaches the merge.
//
// dt-nav migrate is the protocol candidate's bin: DT_PROTOCOL=<modules/protocol>, by default the sibling
// worktree dreamteamer-modules-cr-dt-008.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { offline, registry, run, out, readFile, git, snapshot, lastFiles, noStack, ENGINE_ROOT, ENV } from './held-out-cr-dt-008-lib.js';
import { readNavDoc } from '../../src/nav.js';

const PROTOCOL = process.env.DT_PROTOCOL ?? path.resolve(ENGINE_ROOT, '..', 'dreamteamer-modules-cr-dt-008', 'modules', 'protocol');
const DT_NAV = path.join(PROTOCOL, 'bin', 'dt-nav.mjs');
const dtNav = (root) => {
	assert.ok(fs.existsSync(DT_NAV), `the protocol candidate's dt-nav is needed: ${DT_NAV} (set DT_PROTOCOL)`);
	const r = spawnSync(process.execPath, [DT_NAV, 'migrate', root], { cwd: root, encoding: 'utf8', env: ENV, timeout: 120_000 });
	return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

const STEP1 = '{\n  // editor\n  "editor.tabSize": 2,\n  /* layers */\n  "dreamteamer.layersFolder": "Projects", // one folder\n  // "dreamteamer.navOrder": ["fixas"],\n  "files.exclude": { "**/.git": true, },\n}';
const STEP3 = '{\n  // editor\n  "editor.tabSize": 2,\n  /* layers */\n  "dreamteamer.layersFolder": "Projects", // one folder\n  // "dreamteamer.navOrder": ["fixas"],\n  "dreamteamer.navHidden": ["fixas"],\n  "files.exclude": { "**/.git": true, },\n}';
const EMPTY = '{\n  // empty nav settings\n  "dreamteamer.navOrder": [],\n  "dreamteamer.navGroups": {},\n}';
const GUARD_PARTS = ['your nav settings are not saved to nav.yaml yet', 'dt-nav migrate', '--allow nav-reset'];
const FIXTURES = [{ folder: 'Fixtures', items: ['fixas', 'fixcs'] }];

let REG;
before(() => { REG = registry(); });
const settings = (root, text, commit = true) => {
	fs.mkdirSync(path.join(root, '.vscode'), { recursive: true });
	fs.writeFileSync(path.join(root, '.vscode', 'settings.json'), text);
	if (commit) { git(root, ['add', '-f', '.vscode/settings.json']); git(root, ['commit', '-qm', 'settings']); }
};
const assertGuard = (r) => { for (const p of GUARD_PARTS) assert.ok(r.stderr.includes(p), `stderr names "${p}": ${out(r)}`); };

describe('held-out he6 — JSONC settings, layersFolder alone, and the nav guard', () => {
	test('step 2: only layersFolder (and a commented-out navOrder) — installs, merges, commits nav.yaml', () => {
		const ws = offline();
		settings(ws.root, STEP1);
		const r = run(ws.root, ['install', '@fix/set@1.0.0', '--from', REG]);
		assert.equal(r.code, 0, out(r));
		assert.doesNotMatch(r.stderr + r.stdout, /not saved to nav\.yaml|settings found/);
		assert.deepEqual(readNavDoc(ws.root)?.tree, FIXTURES);
		assert.ok(lastFiles(ws.root).includes('nav.yaml'), lastFiles(ws.root).join(','));
		assert.equal(readFile(ws.root, '.vscode/settings.json'), STEP1, 'settings untouched');
	});

	test('step 3: a real navHidden (trailing comma) refuses before npm, writing nothing', () => {
		const ws = offline();
		settings(ws.root, STEP3);
		const before = snapshot(ws.root);
		const r = run(ws.root, ['install', '@fix/set@1.0.0', '--from', REG]);
		assert.equal(r.code, 1, out(r));
		assert.doesNotMatch(r.stdout, /▶ npm/, 'before npm');
		assertGuard(r);
		assert.deepEqual(snapshot(ws.root), before, 'package.json byte-identical, nothing written');
		assert.equal(fs.existsSync(path.join(ws.root, 'nav.yaml')), false);
	});

	test('step 4: an unparseable settings file is no evidence of nav settings — the merge runs', () => {
		const ws = offline();
		settings(ws.root, '{ not json');
		const r = run(ws.root, ['install', '@fix/set@1.0.0', '--from', REG]);
		assert.equal(r.code, 0, out(r));
		assert.ok(noStack(r.stderr + r.stdout), out(r));
		assert.deepEqual(readNavDoc(ws.root)?.tree, FIXTURES);
	});

	test('step 5: empty nav values — the engine and dt-nav migrate agree', () => {
		const ws = offline();
		settings(ws.root, EMPTY);
		// dt-nav migrate on a copy of the same workspace, before anything else runs
		const copy = fs.mkdtempSync(path.join(path.dirname(ws.root), 'copy-'));
		fs.cpSync(ws.root, copy, { recursive: true, dereference: false, verbatimSymlinks: true });
		const m = dtNav(copy);
		assert.equal(m.code, 0, `dt-nav migrate: ${out(m)}`);
		const r = run(ws.root, ['install', '@fix/set@1.0.0', '--from', REG]);
		assert.ok(noStack(r.stderr + r.stdout), out(r));
		if (r.code === 1 && GUARD_PARTS.every((p) => r.stderr.includes(p))) {
			// the engine refuses: then the settings are migratable, and dt-nav migrate wrote nav.yaml
			assert.doesNotMatch(m.stdout, /nothing to migrate/, `engine refused, so dt-nav must migrate: ${m.stdout}`);
			assert.ok(fs.existsSync(path.join(copy, 'nav.yaml')), 'dt-nav migrate wrote nav.yaml');
		} else {
			// the engine does not refuse (the plan: an empty list or map is no setting) — dt-nav agrees
			assert.equal(r.code, 0, out(r));
			assert.deepEqual(readNavDoc(ws.root)?.tree, FIXTURES, 'the merge ran');
			assert.match(m.stdout, /nothing to migrate/, `the engine did not refuse, so dt-nav has nothing to migrate: ${m.stdout}`);
			assert.equal(fs.existsSync(path.join(copy, 'nav.yaml')), false);
		}
	});

	test('step 6: dt update refuses with the same line; --allow nav-reset goes through and reaches the merge', () => {
		// as the record says: @fix/a, whose updated closure ships no fragment
		const ws = offline();
		const a = run(ws.root, ['install', '@fix/a@1.0.0', '--from', REG]);
		assert.equal(a.code, 0, out(a));
		settings(ws.root, STEP3);
		const pkg = readFile(ws.root, 'package.json');
		const r = run(ws.root, ['update', '@fix/a', '--from', REG]);
		assert.equal(r.code, 1, out(r));
		assertGuard(r);
		assert.equal(readFile(ws.root, 'package.json'), pkg, 'package.json unchanged');
		const ok = run(ws.root, ['update', '@fix/a', '--from', REG, '--allow', 'nav-reset']);
		assert.equal(ok.code, 0, out(ok));
		assert.equal(fs.existsSync(path.join(ws.root, 'nav.yaml')), false, 'no fragment in this closure, so no nav.yaml');

		// and a closure that ships a fragment: nav-reset reaches the merge, nav.yaml then exists
		const ws2 = offline();
		const s = run(ws2.root, ['install', '@fix/set@1.0.0', '--from', REG]);
		assert.equal(s.code, 0, out(s));
		git(ws2.root, ['rm', '-q', 'nav.yaml']);
		git(ws2.root, ['commit', '-qm', 'no nav']);
		settings(ws2.root, STEP3);
		const pkg2 = readFile(ws2.root, 'package.json');
		const r2 = run(ws2.root, ['update', '@fix/set', '--from', REG]);
		assert.equal(r2.code, 1, out(r2));
		assertGuard(r2);
		assert.equal(readFile(ws2.root, 'package.json'), pkg2);
		const ok2 = run(ws2.root, ['update', '@fix/set', '--from', REG, '--allow', 'nav-reset']);
		assert.equal(ok2.code, 0, out(ok2));
		assert.deepEqual(readNavDoc(ws2.root)?.tree, [{ folder: 'Fixtures', items: ['fixas', 'fixcs', 'fixds'] }], 'nav-reset reached the merge');
		assert.equal(readFile(ws2.root, '.vscode/settings.json'), STEP3, 'the settings stay in the file');
	});
});
