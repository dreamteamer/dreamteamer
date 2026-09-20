// Tier 2 — `group: system` is what "machinery" means, and it is NOT "build output".
//
// Until this partition was read, one predicate (`storage.base === 'runtime'`) answered both
// questions, and `repos` was the first collection that is the workspace's own machinery without
// being build output. The partition is AUTHORED on the descriptor — the ten core collections all
// carry `group: system` — so a workspace-stored collection can join it (`repos`, and `assets` in the
// dogfood vault) and a runtime-stored one could in principle leave it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { load } from '../../src/yaml.js';
import { workspace, readFile, simpleCollection, writeCollection, compileQuietly } from '../helpers/ws.js';

const compiled = (ws, name) => load(readFile(ws.root, `.dreamteamer/collections/${name}.collection.yaml`));

describe('the system partition', () => {
	test('a runtime-stored collection carries group: system', () => {
		const ws = workspace();
		assert.equal(compiled(ws, 'skills').group, 'system');
	});

	test('an ordinary workspace collection is in no partition at all', () => {
		const ws = workspace();
		assert.equal(compiled(ws, 'notes').group, undefined);
	});

	test('an authored group: system survives compile without moving the records', () => {
		const ws = workspace({ compile: false });
		writeCollection(ws.root, 'widgets', { ...simpleCollection(), group: 'system' });
		compileQuietly(ws.ws);
		const d = compiled(ws, 'widgets');
		assert.equal(d.group, 'system', 'authored partition must survive compile');
		assert.equal(d.storage.base, 'workspace', 'and must NOT change where records live');
	});

	// ⚠ THE 0.25.0 REGRESSION GUARD. A descriptor key the meta-descriptor does not declare compiles
	// CLEAN and fails `check` — that is exactly how 0.25.0 shipped the ordered id.generate list.
	// `workspace()` (not `workspace({compile: false})`) is required here: only the compiled form
	// returns the `dt` helper this needs.
	test('check accepts the key — the meta-descriptor declares it', () => {
		const ws = workspace();
		writeCollection(ws.root, 'widgets', { ...simpleCollection(), group: 'system' });
		compileQuietly(ws.ws);
		const { code, stdout, stderr } = ws.dt('check');
		assert.equal(code, 0, `check must accept group: — got:\n${stdout}\n${stderr}`);
	});

	test('repos is in the system partition while keeping its records in data/', () => {
		const ws = workspace();
		const d = compiled(ws, 'repos');
		assert.equal(d.group, 'system', 'repos is machinery');
		assert.equal(d.storage.base, 'workspace', 'and its records are still real files under data/');
		assert.equal(d.storage.path, 'data/repos');
	});
});

describe('the generated block', () => {
	const block = (ws) => /<!-- dreamteamer:begin[\s\S]*?dreamteamer:end -->/.exec(readFile(ws.root, 'CLAUDE.md'))[0];

	test('repos is named on the system-collections line, not as a domain collection', () => {
		const b = block(workspace());
		const systemLine = b.split('\n').find((l) => l.startsWith('- system collections'));
		assert.ok(systemLine, 'the system-collections line must exist');
		assert.match(systemLine, /\brepos\b/, 'repos belongs on the system line');
		assert.doesNotMatch(b, /^- repos — /m, 'repos must not be listed as a domain collection');
	});

	test('a workspace that has added nothing renders NO module group for the engine', () => {
		const b = block(workspace());
		assert.doesNotMatch(b, /\*\*System\*\*/, 'a module whose every collection is system is not a domain');
	});

	test('the workspace module still gets its group', () => {
		const b = block(workspace());
		assert.match(b, /\*\*Default\*\*/, 'the workspace module is a domain and keeps its heading');
	});

	// ⚠ THE ACCEPTED CONSEQUENCE OF READING THE PARTITION, pinned because it is a behaviour change
	// and not a side effect. `repos` is not the only workspace-stored collection an operator has put
	// in the `system` partition — the dogfood vault authored `group: system` on `assets`, a
	// `codec: file` collection of icons and logos the UI draws. Reading the partition folds it out of
	// the domain listing onto the system line too, which is what the operator asked for by authoring
	// the group. Any collection that joins the partition gets the same treatment, by name or not.
	test('a workspace-stored collection an operator puts in the partition folds out too — this is `assets`', () => {
		const ws = workspace({ compile: false });
		writeCollection(ws.root, 'assets', { ...simpleCollection(), description: 'A file the UI shows.', group: 'system' });
		compileQuietly(ws.ws);
		const b = block(ws);
		assert.doesNotMatch(b, /^- assets — /m, 'an authored system partition takes it out of the domain listing');
		const systemLine = b.split('\n').find((l) => l.startsWith('- system collections'));
		assert.match(systemLine, /real files you edit like any other:[^.]*\bassets\b/,
			'and it joins `repos` on the data-backed clause, never the build-output one');
	});

	// Finding 1 (CRITICAL, this task): one predicate used to answer both "group it out of the domain
	// listing" and "it is build output", and they diverged at `repos` — machinery whose records are
	// real files under `data/repos`, not `.dreamteamer/`. This pins the split: a runtime-stored
	// collection is named build output, `repos` is named on its own clause instead, never both.
	test('the system-collections line names generated build output and data-backed machinery separately', () => {
		const b = block(workspace());
		const systemLine = b.split('\n').find((l) => l.startsWith('- system collections'));
		assert.ok(systemLine, 'the system-collections line must exist');
		assert.match(systemLine, /it is build output: [^.]*\bskills\b/, 'a runtime-stored collection must be named as build output');
		assert.doesNotMatch(systemLine, /it is build output: [^.]*\brepos\b/, 'repos records are real files, not build output — the false sentence Finding 1 fixed');
		assert.match(systemLine, /real files you edit like any other:[^.]*\brepos\b/, 'repos gets its own clause instead');
	});
});
