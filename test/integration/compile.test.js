// Tier 2 — the compiler's contracts: what it merges, what it refuses, and what it writes into the
// runtime for the record layer to read.
//
// Most of these exist because the failure mode was SILENCE. Decision 156 is the pattern: a kind the
// engine had stopped knowing sat in a module for two days while compile reported ✔. Every assertion
// below that checks for an ERROR is guarding against a repeat of that shape.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, writeCollection, simpleCollection, compileError, compileQuietly, readFile, dt, WS_MODULE } from '../helpers/ws.js';
import { load } from '../../src/yaml.js';

const uncompiled = (opts) => workspace({ ...opts, compile: false });
const dtCheck = (root) => dt(root, 'check');

describe('the runtime artifact', () => {
	test('storage.base is written, not left to a path test', () => {
		const ws = workspace({ collections: { widgets: simpleCollection({ storage: { suffix: 'widget' } }) } });
		assert.equal(ws.store.descriptor('widgets').storage.base, 'workspace');
		// a compiled-source collection: its records live in the gitignored runtime
		assert.equal(ws.store.descriptor('collections').storage.base, 'runtime');
		assert.equal(ws.store.descriptor('skills').storage.base, 'runtime');
	});

	test('the manifest records provenance and the declared namespaces', () => {
		const ws = workspace({ namespaces: ['health'] });
		const manifest = load(readFile(ws.root, '.dreamteamer/manifest.yaml'));
		assert.deepEqual(manifest.namespaces, ['health']);
		assert.ok(manifest.compiled, 'a compile timestamp');
		assert.ok(manifest.modules.some((m) => m.name === 'dreamteamer'), 'the engine is a compiled module');
		assert.ok(Object.keys(manifest.entries).length > 0);
	});

	test('a workspace with no namespaces gets an empty list, not a missing key', () => {
		const ws = workspace();
		assert.deepEqual(load(readFile(ws.root, '.dreamteamer/manifest.yaml')).namespaces, []);
		assert.deepEqual(ws.store.namespaces, []);
	});

	test('titles and title_template are resolved by compile so no surface re-derives them', () => {
		const ws = workspace({ collections: { 'widget-parts': simpleCollection({ storage: { suffix: 'part' } }) } });
		const d = ws.store.descriptor('widget-parts');
		assert.equal(d.title, 'Widget Parts');
		assert.equal(d.title_template, '{{ name }}');
		assert.equal(d.owner, `modules/${WS_MODULE}`);
	});
});

describe('extends — overlaying another module\'s collection', () => {
	test('an overlay adds fields and keeps the base owner and storage', () => {
		const ws = uncompiled({ collections: { widgets: simpleCollection({ storage: { suffix: 'widget' } }) } });
		// a SECOND descriptor for the same name, declaring the overlay
		writeCollection(ws.root, 'widgets-overlay', {});
		fs.writeFileSync(
			path.join(ws.root, 'modules', WS_MODULE, 'collections', 'widgets-overlay.collection.yaml'),
			`name: widgets\nextends: ${WS_MODULE}/widgets\nschema:\n  properties:\n    urgent: { type: boolean, default: false }\n`,
		);
		compileQuietly(ws.ws);
		const d = load(readFile(ws.root, '.dreamteamer/collections/widgets.collection.yaml'));
		assert.equal(d.schema.properties.urgent.type, 'boolean');
		assert.equal(d.schema.properties.name.type, 'string', 'the base field survives');
		assert.equal(d.storage.suffix, 'widget', 'storage comes from the base');
	});

	test('two same-name descriptors with no extends is a hard error naming both', () => {
		const ws = uncompiled({ collections: { widgets: simpleCollection({ storage: { suffix: 'widget' } }) } });
		fs.writeFileSync(
			path.join(ws.root, 'modules', WS_MODULE, 'collections', 'dupe.collection.yaml'),
			'name: widgets\nschema:\n  type: object\n  properties: { name: { type: string } }\n',
		);
		const err = compileError(ws.ws);
		assert.match(err, /name collision on collection "widgets"/);
		assert.match(err, /must declare 'extends: <module>/);
	});

	test('an extends that does not name the real base is refused', () => {
		const ws = uncompiled({ collections: { widgets: simpleCollection({ storage: { suffix: 'widget' } }) } });
		fs.writeFileSync(
			path.join(ws.root, 'modules', WS_MODULE, 'collections', 'bad-overlay.collection.yaml'),
			'name: widgets\nextends: someone-else/widgets\nschema:\n  properties: { urgent: { type: boolean } }\n',
		);
		assert.match(compileError(ws.ws), /does not name the base/);
	});

	test('a descriptor group that is ALL overlays has no base and is refused', () => {
		const ws = uncompiled();
		fs.writeFileSync(
			path.join(ws.root, 'modules', WS_MODULE, 'collections', 'orphan.collection.yaml'),
			'name: orphans\nextends: nobody/orphans\nschema:\n  properties: { x: { type: string } }\n',
		);
		assert.match(compileError(ws.ws), /no base found/);
	});
});

describe('descriptor validation', () => {
	test('a descriptor without name or schema is refused', () => {
		const ws = uncompiled();
		fs.writeFileSync(path.join(ws.root, 'modules', WS_MODULE, 'collections', 'broken.collection.yaml'), 'description: nope\n');
		assert.match(compileError(ws.ws), /needs 'name' and 'schema'/);
	});

	test('a malformed JSON Schema is refused at compile, not at the first write', () => {
		const ws = uncompiled();
		writeCollection(ws.root, 'broken', { schema: { type: 'object', properties: { name: 'not-an-object' } } });
		assert.match(compileError(ws.ws), /not a valid JSON Schema/);
	});

	// Without this gate `patternRe` throws a raw "Invalid regular expression" from inside store.add.
	test('a malformed id.pattern is refused at compile', () => {
		const ws = uncompiled();
		writeCollection(ws.root, 'broken', simpleCollection({ storage: { suffix: 'b' }, id: { generate: '{{ name | slug }}', pattern: '([' } }));
		assert.match(compileError(ws.ws), /id\.pattern is not a valid regular expression/);
	});

	// A ui-view's filter narrows what the operator SEES, so a typo'd operator is worse than an error:
	// review finding 5 was a `_nq` matching EVERYTHING, which showed every user's tasks with no signal.
	// `filter` is a TOP-LEVEL key on a ui-view, a sibling of `options` — which is where the schema puts
	// it and where the studio writes it. Asserting the location matters as much as the refusal: the first
	// version of this test put the filter under `options.filter`, where nothing reads it, so it passed
	// while proving nothing.
	const uiView = (body) => {
		const ws = uncompiled({ collections: { widgets: simpleCollection({ storage: { suffix: 'widget' } }) } });
		const dir = path.join(ws.root, 'modules', WS_MODULE, 'ui-views');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'v.ui-view.yaml'),
			`path: /v\ntarget: list\ncollection: collections/widgets\nlayout: table\n${body}`);
		return ws;
	};

	test('a ui-view filter with an unknown operator is refused', () => {
		const err = compileError(uiView('filter: { name: { _nq: x } }\n').ws);
		assert.match(err, /unknown filter operator\(s\) _nq/);
	});

	test('a ui-view filter with a KNOWN operator compiles', () => {
		assert.equal(compileError(uiView('filter: { name: { _eq: x } }\n').ws), null);
	});

	test('a nested _and branch is validated too', () => {
		const err = compileError(uiView('filter: { _and: [{ name: { _bogus: 1 } }] }\n').ws);
		assert.match(err, /_bogus/);
	});

	// The DIVISION OF LABOUR, worth pinning because it looks like a gap and is not: compile validates a
	// value if and only if the engine INTERPRETS it (filter operators — see the comment above the
	// ui-view loop in compile.js), while a dangling REFERENCE is `check`'s job via `x-reference`. So a
	// ui-view naming a collection that does not exist compiles clean and `check` reports it precisely.
	// Not silence — a later, more specific error.
	test('a ui-view naming an unknown collection compiles, and CHECK reports it', () => {
		const ws = uncompiled();
		const dir = path.join(ws.root, 'modules', WS_MODULE, 'ui-views');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'v.ui-view.yaml'),
			'path: /v\ntarget: list\ncollection: collections/nope\nlayout: table\n');
		assert.equal(compileError(ws.ws), null);

		const res = ws.dt ? ws.dt('check') : null;
		const out = res ?? dtCheck(ws.root);
		assert.equal(out.code, 1);
		assert.match(out.stdout, /dangling reference "collections\/nope"/);
	});

	test('a ui-view can target a NAMESPACED collection', () => {
		const ws = uncompiled({
			namespaces: ['health'],
			collections: { 'health/doctors': simpleCollection({ storage: { suffix: 'doctor' } }) },
		});
		const dir = path.join(ws.root, 'modules', WS_MODULE, 'ui-views');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'v.ui-view.yaml'),
			'path: /doctors\ntarget: list\ncollection: collections/health/doctors\nlayout: table\n');
		assert.equal(compileError(ws.ws), null, 'a qualified name is just a record id of `collections`');
	});
});

describe('disable', () => {
	test('a disabled collection does not reach the runtime', () => {
		const ws = uncompiled({ collections: { widgets: simpleCollection({ storage: { suffix: 'widget' } }) } });
		const pkgFile = path.join(ws.root, 'package.json');
		const pkg = JSON.parse(readFile(ws.root, 'package.json'));
		pkg.dreamteamer.disable = [`${WS_MODULE}/widgets`];
		fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, '\t'));
		compileQuietly({ root: ws.root, pkg });
		assert.equal(readFile(ws.root, '.dreamteamer/collections/widgets.collection.yaml'), null);
	});

	test('a namespaced collection is disabled by its qualified name', () => {
		const ws = uncompiled({
			namespaces: ['health'],
			collections: { 'health/doctors': simpleCollection({ storage: { suffix: 'doctor' } }) },
		});
		const pkg = JSON.parse(readFile(ws.root, 'package.json'));
		pkg.dreamteamer.disable = [`${WS_MODULE}/health/doctors`];
		fs.writeFileSync(path.join(ws.root, 'package.json'), JSON.stringify(pkg, null, '\t'));
		compileQuietly({ root: ws.root, pkg });
		assert.equal(readFile(ws.root, '.dreamteamer/collections/health/doctors.collection.yaml'), null);
	});
});

describe('stray source folders in a module', () => {
	test('an unrecognized folder at a module root is a compile ERROR, not a silent skip', () => {
		const ws = uncompiled();
		fs.mkdirSync(path.join(ws.root, 'modules', WS_MODULE, 'workflows'), { recursive: true });
		fs.writeFileSync(path.join(ws.root, 'modules', WS_MODULE, 'workflows', 'x.workflow.yaml'), 'name: x\n');
		const err = compileError(ws.ws);
		assert.ok(err, 'a folder that is not a known kind must fail the compile');
		assert.match(err, /workflows/);
	});

	test('a generic package folder is allowed', () => {
		const ws = uncompiled();
		fs.mkdirSync(path.join(ws.root, 'modules', WS_MODULE, 'src'), { recursive: true });
		fs.writeFileSync(path.join(ws.root, 'modules', WS_MODULE, 'src', 'index.js'), '// nothing\n');
		assert.equal(compileError(ws.ws), null);
	});

	test('a module can declare its own ignore list', () => {
		const ws = uncompiled();
		const modPkgFile = path.join(ws.root, 'modules', WS_MODULE, 'package.json');
		const modPkg = JSON.parse(fs.readFileSync(modPkgFile, 'utf8'));
		modPkg.dreamteamer = { ...modPkg.dreamteamer, ignore: ['dashboard'] };
		fs.writeFileSync(modPkgFile, JSON.stringify(modPkg, null, '\t'));
		fs.mkdirSync(path.join(ws.root, 'modules', WS_MODULE, 'dashboard'), { recursive: true });
		fs.writeFileSync(path.join(ws.root, 'modules', WS_MODULE, 'dashboard', 'app.js'), '// ui\n');
		assert.equal(compileError(ws.ws), null);
	});
});

describe('the pre-flatten layout still compiles', () => {
	// ⚠ Keep the `system/<kind>` fallback: recipes modules are COPIED, not installed, with no version
	// discipline, so a module copied out of an older commit arrives nested and must still work.
	test('a descriptor under system/collections/ is found', () => {
		const ws = uncompiled();
		const nested = path.join(ws.root, 'modules', WS_MODULE, 'system', 'collections');
		fs.mkdirSync(nested, { recursive: true });
		fs.rmSync(path.join(ws.root, 'modules', WS_MODULE, 'collections'), { recursive: true, force: true });
		fs.writeFileSync(
			path.join(nested, 'legacy.collection.yaml'),
			'name: legacy\nstorage: { suffix: legacy }\nid: { generate: "{{ name | slug }}" }\nschema:\n  type: object\n  required: [name]\n  properties: { name: { type: string } }\n',
		);
		assert.equal(compileError(ws.ws), null);
		assert.ok(readFile(ws.root, '.dreamteamer/collections/legacy.collection.yaml'));
	});
});

describe('staleness', () => {
	test('editing a source marks the runtime stale and dt status says so', () => {
		const ws = workspace({ collections: { widgets: simpleCollection({ storage: { suffix: 'widget' } }) } });
		assert.match(ws.dt('status').stdout, /is fresh/);

		writeCollection(ws.root, 'widgets', simpleCollection({ storage: { suffix: 'widget' }, description: 'changed' }));
		const res = ws.dt('status');
		assert.equal(res.code, 1);
		assert.match(res.stdout, /stale/);
	});
});

describe('the harness orientation block', () => {
	// This prose is written into `.claude/CLAUDE.md` (and AGENTS.md / GEMINI.md / .cursor) for EVERY
	// workspace, so it is the highest-leverage text in the project — and the first thing an agent reads.
	// Prose that contradicts the workspace is worse than no prose, which is why both the layout and the
	// namespace list are passed in rather than assumed.
	const claudeMd = (ws) => readFile(ws.root, 'CLAUDE.md') ?? '';

	test('the engine version is DERIVED, not a hardcoded string', () => {
		const ws = workspace();
		const version = JSON.parse(readFile(ws.root, 'node_modules/dreamteamer/package.json')).version;
		assert.match(claudeMd(ws), new RegExp(`operated by dreamteamer v${version.replace(/\./g, '\\.')}`));
	});

	test('a workspace WITHOUT namespaces gets no namespace sentence', () => {
		assert.doesNotMatch(claudeMd(workspace()), /declares NAMESPACES/);
	});

	// The rule an agent cannot derive on its own: a reference splits at the end of the DECLARED prefix,
	// not at the first slash. Without this line, `health/doctors/dana-levi` reads as collection `health`.
	test('a namespaced workspace is told the declared list and the splitting rule', () => {
		const ws = workspace({
			namespaces: ['health', 'work/clients'],
			collections: { 'health/doctors': simpleCollection({ storage: { suffix: 'doctor' } }) },
		});
		const md = claudeMd(ws);
		assert.match(md, /declares NAMESPACES/);
		assert.match(md, /`health`/);
		assert.match(md, /`work\/clients`/);
		assert.match(md, /DECLARED prefix, not at the first slash/);
	});
});

// ⚠ THE LEXICON IS THE HALF OF THE DSL THAT WAS MISSING AT t=0. A workspace could state the shape of
// a reference and not name one collection it could point at — and the dogfood vault's hand-written
// substitute in CLAUDE.md named three collections for 48 hours after they were deleted. These guard
// the properties that made it safe to derive: every non-system collection present, schema-ops ones
// collapsed, `use_when` rendered only when authored, and BYTE-STABILITY across compiles — that last
// one because this block lands in three COMMITTED root files, where churn is somebody else's merge.
describe('the orientation block names the workspace', () => {
	test('every non-system collection appears; schema-ops ones group into one line', () => {
		const ws = workspace({ collections: { widgets: simpleCollection({ description: 'a widget', storage: { suffix: 'widget' } }) } });
		const block = readFile(ws.root, 'CLAUDE.md');
		assert.match(block, /^- widgets — a widget$/m);
		assert.match(block, /^- schema-ops only \(write with the meta verbs, never by hand\): .*collections/m);
		assert.doesNotMatch(block, /^- collections —/m, 'a schema-ops collection must not get its own line');
	});

	test('use_when renders as an indented clause, and its absence renders nothing', () => {
		const ws = workspace({ collections: {
			gadgets: simpleCollection({ description: 'a gadget', use_when: 'you need a gadget', storage: { suffix: 'gadget' } }),
			widgets: simpleCollection({ description: 'a widget', storage: { suffix: 'widget' } }),
		} });
		const block = readFile(ws.root, 'CLAUDE.md');
		assert.match(block, /^ {4}use when: you need a gadget$/m);
		assert.doesNotMatch(block, /^- widgets — a widget\n {4}use when:/m, 'no empty clause where none was authored');
	});

	test('the block is byte-stable across two compiles — it lives in a COMMITTED file', () => {
		const ws = workspace({ collections: { widgets: simpleCollection({ description: 'a widget', storage: { suffix: 'widget' } }) } });
		const first = readFile(ws.root, 'CLAUDE.md');
		compileQuietly(ws.ws);
		assert.equal(readFile(ws.root, 'CLAUDE.md'), first, 'a second compile must not re-dirty CLAUDE.md');
	});

	test('compile names every collection missing a description, and still succeeds', () => {
		const ws = uncompiled({ collections: { widgets: simpleCollection({ storage: { suffix: 'widget' } }) } });
		const { code, warnings } = compileQuietly(ws.ws);
		assert.equal(code, 0, 'a missing description is a warning, never a failure');
		assert.ok(warnings.some((w) => w.includes('collection widgets has no description')), warnings.join('\n'));
	});

	// The budget scripts/metrics.mjs cannot hold: it measures the ENGINE repo, and this block is
	// generated per WORKSPACE. Raising this is a deliberate act — do it in the same commit as the
	// growth and say why, exactly like metrics.json.
	test('a workspace that has added nothing gets a SMALL block', () => {
		const ws = workspace();
		const block = /<!-- dreamteamer:begin[\s\S]*?dreamteamer:end -->/.exec(readFile(ws.root, 'CLAUDE.md'))[0];
		const n = block.split('\n').length;
		assert.ok(n <= 32, `virgin orientation block is ${n} lines, budget 32`);
	});
});
