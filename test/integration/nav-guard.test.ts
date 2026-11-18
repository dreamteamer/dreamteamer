// rnd/tests/dreamteamer/nav-guard — cr-dt-008, design §5: old nav settings and no nav.yaml mean the workspace
// still draws by those settings, so install and update of a module refuse BEFORE npm until they are migrated —
// or until `--allow nav-reset` says to start from the fragments. The engine's own update is never guarded.
// Offline against the fixture registry, as install-modules.test.ts runs.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { workspace, ENGINE_ROOT, git, readFile, treeHash } from '../helpers/ws.ts';
import { buildRegistry } from '../fixtures/registry/build.mjs';
import { readNavDoc } from '../../src/nav.ts';
import { NAV_GUARD_LINE } from '../../src/nav-fragments.ts';

const BIN = path.join(ENGINE_ROOT, 'bin', 'dreamteamer.js');
let REG;
before(() => { REG = buildRegistry(); });
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-home-'));
const ENV = { PATH: process.env.PATH, HOME, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
const run = (root, args) => {
	const r = spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8', timeout: 180_000, killSignal: 'SIGKILL', env: ENV });
	return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};
function offline() {
	const ws = workspace();
	const pkgFile = path.join(ws.root, 'package.json');
	const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
	pkg.dependencies = { ...pkg.dependencies, dreamteamer: `file:${ENGINE_ROOT}` };
	fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, '\t') + '\n');
	git(ws.root, ['add', '-A']);
	if (git(ws.root, ['status', '--porcelain'])) git(ws.root, ['commit', '-qm', 'fixture: offline engine']);
	return ws;
}
const SETTINGS = '{\n  // the old nav\n  "dreamteamer.navOrder": ["fixas"],\n}\n';
const withSettings = (root) => {
	fs.mkdirSync(path.join(root, '.vscode'), { recursive: true });
	fs.writeFileSync(path.join(root, '.vscode', 'settings.json'), SETTINGS);
	git(root, ['add', '-f', '.vscode/settings.json']);
	git(root, ['commit', '-qm', 'old nav settings']);
};
const ok = (r) => assert.equal(r.code, 0, r.stderr + r.stdout);

describe('the nav guard before npm', () => {
	test('dt install of a module preset refuses with the line and writes nothing; --allow nav-reset installs and writes nav.yaml', () => {
		const ws = offline();
		withSettings(ws.root);
		const before = treeHash(ws.root);
		const r = run(ws.root, ['install', '@fix/set@1.0.0', '--from', REG]);
		assert.equal(r.code, 1, r.stderr + r.stdout);
		assert.ok(r.stderr.includes(NAV_GUARD_LINE), r.stderr);
		assert.equal(treeHash(ws.root), before, 'nothing written');
		ok(run(ws.root, ['install', '@fix/set@1.0.0', '--from', REG, '--allow', 'nav-reset']));
		assert.deepEqual(readNavDoc(ws.root).tree, [{ folder: 'Fixtures', items: ['fixas', 'fixcs'] }]);
		assert.equal(readFile(ws.root, '.vscode/settings.json'), SETTINGS, 'the settings stay, unread');
	});
	test('dt update of a plain module refuses with the line; --allow nav-reset updates', () => {
		const ws = offline();
		ok(run(ws.root, ['install', '@fix/a@1.0.0', '--from', REG]));
		withSettings(ws.root);
		const pkg = readFile(ws.root, 'package.json');
		const r = run(ws.root, ['update', '@fix/a', '--from', REG]);
		assert.equal(r.code, 1, r.stderr + r.stdout);
		assert.ok(r.stderr.includes(NAV_GUARD_LINE), r.stderr);
		assert.equal(readFile(ws.root, 'package.json'), pkg);
		ok(run(ws.root, ['update', '@fix/a', '--from', REG, '--allow', 'nav-reset']));
	});
	test('dt update of a module preset refuses with the line', () => {
		const ws = offline();
		ok(run(ws.root, ['install', '@fix/set@1.0.0', '--from', REG]));
		git(ws.root, ['rm', '-q', 'nav.yaml']);
		git(ws.root, ['commit', '-qm', 'no nav']);
		withSettings(ws.root);
		const r = run(ws.root, ['update', '@fix/set', '--from', REG]);
		assert.equal(r.code, 1, r.stderr + r.stdout);
		assert.ok(r.stderr.includes(NAV_GUARD_LINE), r.stderr);
	});
	test('dt update --engine is never guarded', () => {
		const ws = offline();
		withSettings(ws.root);
		const link = path.join(ws.root, 'node_modules', 'dreamteamer');
		fs.rmSync(link, { recursive: true, force: true });
		fs.mkdirSync(link);
		fs.writeFileSync(path.join(link, 'package.json'), JSON.stringify({ name: 'dreamteamer', version: '0.0.1' }));
		const r = run(ws.root, ['update', '--engine', '--from', REG]);
		assert.equal(r.code, 1, r.stderr + r.stdout);
		assert.match(r.stderr, /no dreamteamer in/);
		assert.ok(!r.stderr.includes(NAV_GUARD_LINE) && !r.stdout.includes(NAV_GUARD_LINE));
	});
	test('dt setup does not take nav-reset', () => {
		const ws = offline();
		const r = run(ws.root, ['setup', '--allow', 'nav-reset']);
		assert.equal(r.code, 2, r.stderr + r.stdout);
	});
	test('dt update --allow names both kinds', () => {
		const ws = offline();
		const r = run(ws.root, ['update', '@fix/a', '--allow', 'everything']);
		assert.match(r.stderr, /dt update --allow takes downgrade or nav-reset \(got "everything"\)/);
	});
});

// rnd/tests/dreamteamer/nav-guard-names-published-versions — the remedy the refusal prints has to run as
// written: npm holds @dreamteamer/protocol 0.1.0, 0.1.1 and 0.3.0 (0.3.0 is the one with `dt-nav migrate`),
// and the first editor that writes nav.yaml is 0.27.0 (no 0.26 was released). A doc that repeats the
// command drifts with it, so every shipped text is scanned, not only the line.
describe('the nav migration remedy names versions that exist', () => {
	const shipped = () => {
		const out = [];
		const walk = (dir, ext) => {
			for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
				const p = path.join(dir, e.name);
				if (e.isDirectory()) walk(p, ext);
				else if (e.name.endsWith(ext)) out.push(p);
			}
		};
		walk(path.join(ENGINE_ROOT, 'src'), '.ts');
		walk(path.join(ENGINE_ROOT, 'skills'), '.md');
		walk(path.join(ENGINE_ROOT, 'docs'), '.md');
		for (const f of ['UPDATING.md', 'README.md', 'FAQ.md', 'EXTENDING.md']) out.push(path.join(ENGINE_ROOT, f));
		return out.filter((f) => fs.existsSync(f));
	};
	test('the refusal line runs as written: protocol 0.3, editor 0.27', () => {
		assert.ok(NAV_GUARD_LINE.includes('npx -p @dreamteamer/protocol@0.3 dt-nav migrate'), NAV_GUARD_LINE);
		assert.ok(NAV_GUARD_LINE.includes('the editor 0.27 or later'), NAV_GUARD_LINE);
	});
	test('every shipped text that spells the command names protocol 0.3 and never the editor 0.26', () => {
		const wrong = [];
		for (const f of shipped()) {
			const text = fs.readFileSync(f, 'utf8');
			for (const m of text.matchAll(/@dreamteamer\/protocol@(\d+(?:\.\d+)*)/g)) if (m[1] !== '0.3') wrong.push(`${path.relative(ENGINE_ROOT, f)}: protocol@${m[1]}`);
			for (const m of text.matchAll(/editor 0\.26\b/g)) wrong.push(`${path.relative(ENGINE_ROOT, f)}: ${m[0]}`);
		}
		assert.deepEqual(wrong, []);
	});
});
