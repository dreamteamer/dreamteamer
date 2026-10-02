// Tier 2 — `internal: true` is what "machinery" means, and it is NOT "build output".
//
// Two questions, two answers: `internal` (authored on the descriptor) says a collection is the
// workspace's own plumbing, drawn on the schema surface rather than as a domain noun; `runtime`
// (compiled, from where the records live) says its records are build output under `.dreamteamer/`.
// Every core runtime collection is internal, and a workspace-stored collection can join the
// partition (`repos`, an operator's `assets`) without its records moving.
import { test, describe } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { load } from '../../src/yaml.js';
import { storageOf } from '../../src/descriptor.js';
import { workspace, readFile, simpleCollection, writeCollection, writeModule, compileQuietly, compileError, dt } from '../helpers/ws.js';

const compiled = (ws, name) => load(readFile(ws.root, `.dreamteamer/collections/${name}.collection.yaml`));

describe('the internal partition', () => {
	test('a runtime-stored collection carries internal: true', () => {
		const ws = workspace();
		const d = compiled(ws, 'skills');
		assert.equal(d.internal, true);
		assert.equal(storageOf(d).runtime, true);
	});

	test('an ordinary workspace collection is in no partition at all', () => {
		const ws = workspace();
		assert.equal(compiled(ws, 'notes').internal, undefined);
	});

	test('an authored internal: true survives compile without moving the records', () => {
		const ws = workspace({ compile: false });
		writeCollection(ws.root, 'widgets', { ...simpleCollection(), internal: true });
		compileQuietly(ws.ws);
		const d = compiled(ws, 'widgets');
		assert.equal(d.internal, true, 'authored partition must survive compile');
		assert.equal(storageOf(d).runtime, false, 'and must NOT make its records build output');
		assert.equal(storageOf(d).path, 'data/widgets', 'and must NOT change where records live');
	});

	// ⚠ A descriptor key the meta-descriptor does not declare compiles CLEAN and fails `check`.
	// `workspace()` (not `workspace({compile: false})`) is required here: only the compiled form
	// returns the `dt` helper this needs.
	test('check accepts the key — the meta-descriptor declares it', () => {
		const ws = workspace();
		writeCollection(ws.root, 'widgets', { ...simpleCollection(), internal: true });
		compileQuietly(ws.ws);
		const { code, stdout, stderr } = ws.dt('check');
		assert.equal(code, 0, `check must accept internal: — got:\n${stdout}\n${stderr}`);
	});

	test('a MODULE may not put its collection in the partition — refused by name', () => {
		const ws = workspace({ compile: false });
		writeModule(ws.root, 'kit', { collections: { widgets: { ...simpleCollection(), internal: true } } });
		assert.match(compileError(ws.ws), /collection "widgets": `internal: true` is reserved for the engine's collections and the workspace module's — module kit ships a domain collection \(modules\/kit\/collections\/widgets\.collection\.yaml\)/);
	});

	test('repos is in the internal partition while keeping its records in data/', () => {
		const ws = workspace();
		const d = compiled(ws, 'repos');
		assert.equal(d.internal, true, 'repos is machinery');
		assert.equal(storageOf(d).runtime, false, 'and its records are still real files under data/');
		assert.equal(storageOf(d).path, 'data/repos');
	});
});

describe('the generated block', () => {
	const block = (ws) => /<!-- dreamteamer:begin[\s\S]*?dreamteamer:end -->/.exec(readFile(ws.root, 'CLAUDE.md'))[0];
	/** The block cut at each `**heading**` paragraph — the system section, then one per module. */
	const sections = (b) => b.split(/\n(?=\*\*)/).filter((s) => s.startsWith('**'));
	const systemSection = (b) => sections(b).find((s) => s.startsWith('**System collections**'));
	const systemLine = (b) => systemSection(b)?.split('\n')[0];
	const domainSections = (b) => sections(b).filter((s) => !s.startsWith('**System collections**'));

	test('repos is named on the system-collections line, not as a domain collection', () => {
		const b = block(workspace());
		assert.ok(systemLine(b), 'the system-collections line must exist');
		assert.match(systemLine(b), /\brepos\b/, 'repos belongs on the system line');
		for (const s of domainSections(b)) assert.doesNotMatch(s, /^- repos — /m, 'repos must not be listed as a domain collection');
	});

	test('a workspace that has added nothing renders NO module group for the engine', () => {
		const b = block(workspace());
		assert.doesNotMatch(b, /\*\*System\*\*/, 'a module whose every collection is system is not a domain');
	});

	test('the workspace module still gets its group', () => {
		const b = block(workspace());
		assert.match(b, /\*\*Default\*\*/, 'the workspace module is a domain and keeps its heading');
	});

	// ⚠ THE CONSEQUENCE OF READING THE PARTITION, pinned because it is a behaviour and not a side
	// effect. An operator can put a workspace-stored collection — `assets`, the icons and logos the UI
	// draws — in the internal partition, and it then folds out of the domain listing onto the system
	// section, on the data-backed clause. Any collection that joins the partition gets the same
	// treatment, by name or not.
	test('a workspace-stored collection an operator puts in the partition folds out too — this is `assets`', () => {
		const ws = workspace({ compile: false });
		writeCollection(ws.root, 'assets', { ...simpleCollection(), description: 'A file the UI shows.', internal: true });
		compileQuietly(ws.ws);
		const b = block(ws);
		for (const s of domainSections(b)) assert.doesNotMatch(s, /^- assets — /m, 'an authored internal partition takes it out of the domain listing');
		assert.match(systemLine(b), /Records you edit like any other:[^.]*\bassets\b/,
			'and it joins `repos` on the data-backed clause, never the build-output one');
		assert.doesNotMatch(systemLine(b), /it is build output: [^.]*\bassets\b/);
	});

	// One predicate must not answer both "group it out of the domain listing" and "it is build
	// output": they diverge at `repos` — machinery whose records are real files under `data/repos`,
	// not `.dreamteamer/`. A runtime-stored collection is named build output, `repos` is named on its
	// own clause instead, never both.
	test('the system-collections line names generated build output and data-backed machinery separately', () => {
		const b = block(workspace());
		assert.ok(systemLine(b), 'the system-collections line must exist');
		assert.match(systemLine(b), /it is build output: [^.]*\bskills\b/, 'a runtime-stored collection must be named as build output');
		assert.doesNotMatch(systemLine(b), /it is build output: [^.]*\brepos\b/, 'repos records are real files, not build output');
		assert.match(systemLine(b), /Records you edit like any other:[^.]*\brepos\b/, 'repos gets its own clause instead');
	});
});

describe('a module that ships only extension verbs still heads its own group', () => {
	test('its heading carries its description and a verbs: line', () => {
		const ws = workspace({ compile: false });
		const dir = path.join(ws.root, 'node_modules', '@kits', 'serve-kit');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@kits/serve-kit', version: '1.0.0', dreamteamer: { description: 'Serves the workspace over HTTP.', extension: './ext.js' } }));
		fs.writeFileSync(path.join(dir, 'ext.js'), 'export default () => ({ commands: { serve: { run() { return 0; } }, ping: { run() { return 0; } } } });');
		const pkgFile = path.join(ws.root, 'package.json');
		const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
		fs.writeFileSync(pkgFile, JSON.stringify({ ...pkg, dependencies: { ...pkg.dependencies, '@kits/serve-kit': '*' } }));
		const r = dt(ws.root, 'compile');
		assert.equal(r.code, 0, r.stderr);
		assert.match(/<!-- dreamteamer:begin[\s\S]*?dreamteamer:end -->/.exec(readFile(ws.root, 'CLAUDE.md'))[0],
			/^\*\*[^*]+\*\* \(`serve-kit` · node_modules\/@kits\/serve-kit\) — Serves the workspace over HTTP\.\n {2}verbs: dt ping · dt serve$/m);
	});
});
