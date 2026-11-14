// `dt check modules/<id> --alone` (cr-dt-007, G3, D63, D65): the module packed, installed into a fresh
// workspace on this engine with only its declared dependencies, compiled, checked — exit 0
// publishable, 1 refused naming why, 2 usage. Offline: dependencies are packed from this workspace.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { workspace, ENGINE_ROOT, git } from '../helpers/ws.js';

const BIN = path.join(ENGINE_ROOT, 'bin', 'dreamteamer.js');
const FIX = path.join(ENGINE_ROOT, 'test', 'fixtures', 'alone');
const run = (root, args) => {
	const r = spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8', timeout: 400_000, killSignal: 'SIGKILL', env: { ...process.env, NO_COLOR: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } });
	return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};
/** A workspace holding the named fixtures as inline modules (copied, never compiled here: the gate needs no host compile). */
function host(...ids) {
	const ws = workspace();
	for (const id of ids) fs.cpSync(path.join(FIX, id), path.join(ws.root, 'modules', id), { recursive: true });
	git(ws.root, ['add', '-A']); git(ws.root, ['commit', '-qm', 'fixtures']);
	return ws;
}

describe('dt check modules/<id> --alone', () => {
	test('publishable, with an inline dependency packed alongside: exit 0, the verdict printed', () => {
		const ws = host('alone-base', 'alone-ok');
		const r = run(ws.root, ['check', 'modules/alone-ok', '--alone']);
		assert.equal(r.code, 0, r.stdout + r.stderr);
		assert.match(r.stdout, /✔ modules\/alone-ok is publishable — packed, installed alone \(with alone-base\), compiled, checked/);
	});
	test('a unit that needs an input a stranger supplies later is still publishable: exit 0', () => {
		const ws = host('alone-needs-input');
		const r = run(ws.root, ['check', 'modules/alone-needs-input', '--alone']);
		assert.equal(r.code, 0, r.stdout + r.stderr);
		assert.match(r.stdout, /alone\s+configured/);
		assert.match(r.stdout, /dt setup alone --input token=<token>/);
	});
	test('a dependency nothing here holds: exit 1, named', () => {
		const ws = host('alone-missing-dep');
		const r = run(ws.root, ['check', 'modules/alone-missing-dep', '--alone']);
		assert.equal(r.code, 1, r.stdout + r.stderr);
		assert.match(r.stderr, /✖ modules\/alone-missing-dep: dependency @alone\/nowhere is not installed here/);
	});
	test('a floor above this engine: exit 1, the floor named', () => {
		const ws = host('alone-floor-above');
		const r = run(ws.root, ['check', 'modules/alone-floor-above', '--alone']);
		assert.equal(r.code, 1, r.stdout + r.stderr);
		assert.match(r.stderr, /✖ modules\/alone-floor-above: .*>=99\.0\.0/);
	});
	test('usage: a target without --alone, --alone without a target, a target that is not an inline module', () => {
		const ws = host('alone-base');
		const a = run(ws.root, ['check', 'modules/alone-base']);
		assert.equal(a.code, 2); assert.match(a.stderr, /check takes no target — did you mean --alone\?/);
		const b = run(ws.root, ['check', '--alone']);
		assert.equal(b.code, 2); assert.match(b.stderr, /check --alone takes modules\/<id>/);
		const c = run(ws.root, ['check', 'modules/nope', '--alone']);
		assert.equal(c.code, 2); assert.match(c.stderr, /modules\/nope is not an inline module of this workspace/);
	});
	test('--keep leaves the temp workspace and prints where it is', () => {
		const ws = host('alone-base');
		const r = run(ws.root, ['check', 'modules/alone-base', '--alone', '--keep']);
		assert.equal(r.code, 0, r.stdout + r.stderr);
		const kept = /kept: (\S+)/.exec(r.stdout)?.[1];
		assert.ok(kept && fs.existsSync(path.join(kept, 'package.json')), r.stdout);
		fs.rmSync(path.dirname(kept), { recursive: true, force: true });
	});
});

// rnd/tests/dreamteamer/check-alone-preset — CR-dt-008: the gate packs a module preset's members like
// dependencies, so a preset and a module that depends on one are each publishable alone.
describe('dt check --alone walks module presets', () => {
	test('a module preset is publishable, its member packed alongside', () => {
		const ws = host('alone-base', 'alone-set');
		const r = run(ws.root, ['check', 'modules/alone-set', '--alone']);
		assert.equal(r.code, 0, r.stdout + r.stderr);
		assert.match(r.stdout, /✔ modules\/alone-set is publishable/);
	});
	test('a module depending on a preset, referencing a member\'s collection, is publishable', () => {
		const ws = host('alone-base', 'alone-set', 'alone-via-set');
		const r = run(ws.root, ['check', 'modules/alone-via-set', '--alone']);
		assert.equal(r.code, 0, r.stdout + r.stderr);
		assert.match(r.stdout, /✔ modules\/alone-via-set is publishable/);
	});
});

// cr-dt-008 test-stage fixes (held-out hm11): a member the preset pins and nothing here holds is named
// with its pin and the key that lists it; and the tarball is judged by the package's `files` list — a
// source folder the list leaves out ships nothing, on the module itself or on a member it packs.
describe('dt check --alone judges what the tarball ships', () => {
	const dropCollections = (root, id) => {
		const f = path.join(root, 'modules', id, 'package.json');
		const j = JSON.parse(fs.readFileSync(f, 'utf8'));
		j.files = j.files.filter((x) => x !== 'collections');
		fs.writeFileSync(f, JSON.stringify(j) + '\n');
		git(root, ['commit', '-qam', `${id}: files without collections`]);
	};
	test('a preset member nothing here holds: exit 1, the member, its pin and dreamteamer.preset named', () => {
		const ws = host('alone-set');
		const r = run(ws.root, ['check', 'modules/alone-set', '--alone']);
		assert.equal(r.code, 1, r.stdout + r.stderr);
		assert.match(r.stderr, /alone-base@1\.0\.0/);
		assert.match(r.stderr, /dreamteamer\.preset/);
		assert.doesNotMatch(r.stderr, /dreamteamer\.dependencies/);
	});
	test('a source folder the files list leaves out: exit 1, the folder and the files list named', () => {
		const ws = host('alone-base');
		dropCollections(ws.root, 'alone-base');
		const r = run(ws.root, ['check', 'modules/alone-base', '--alone']);
		assert.equal(r.code, 1, r.stdout + r.stderr);
		assert.match(r.stderr, /collections\/bases\.collection\.yaml/);
		assert.match(r.stderr, /"files"/);
		assert.doesNotMatch(r.stdout, /is publishable/);
	});
	test('a member packed without its collections: the preset is not publishable either', () => {
		const ws = host('alone-base', 'alone-set');
		dropCollections(ws.root, 'alone-base');
		const r = run(ws.root, ['check', 'modules/alone-set', '--alone']);
		assert.equal(r.code, 1, r.stdout + r.stderr);
		assert.match(r.stderr, /alone-base/);
		assert.match(r.stderr, /collections\/bases\.collection\.yaml/);
	});
});
