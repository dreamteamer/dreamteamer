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
import { workspace, writeCollection, simpleCollection, compileError, compileQuietly, readFile, tree, dt, WS_MODULE } from '../helpers/ws.js';
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

	// ⚠ THE SILENT FAILURE THE COMMENT ABOVE PREDICTED, found in the wild. `options` is open by
	// contract, so a `filter` written inside it is accepted, saved, round-tripped — and read by
	// nothing. The view drew every record of a collection it was supposed to narrow, and compile,
	// check and the surface all said ✔. A warning rather than a failure, because `options` really is
	// open and a surface may legitimately want a colliding key; but the operator has to be told,
	// since the symptom is a view that looks like it works.
	const warningsFor = (body) => compileQuietly(uiView(body).ws).warnings.join('\n');

	test('a filter hidden inside options is warned about, naming the key', () => {
		const warn = warningsFor('options: { filter: { name: { _eq: x } } }\n');
		assert.match(warn, /options\.filter is read by nothing/);
		assert.match(warn, /one level up/);
	});

	test('the warning does not fail the compile — options is open by contract', () => {
		assert.equal(compileError(uiView('options: { filter: { name: { _eq: x } } }\n').ws), null);
	});

	// Every field ui-views owns, not a hardcoded list of one: `sort` and `columns` are the other two
	// anyone will actually type, and the check reads the merged descriptor so it keeps covering a
	// field the collection grows later.
	test('any sibling field shadowed inside options is warned about', () => {
		const warn = warningsFor('options: { path: /elsewhere, layout: kanban }\n');
		assert.match(warn, /options\.path is read by nothing/);
		assert.match(warn, /options\.layout is read by nothing/);
	});

	test('a genuine layout option is left alone', () => {
		// `columns` and `sort` ARE ui-view fields... but `group-by` is not, and neither is anything a
		// module's own list registers. Those must ride through silently or the warning is noise.
		const warn = warningsFor('options: { group-by: status, swimlanes: true }\n');
		assert.doesNotMatch(warn, /read by nothing/);
	});

	test('a view with no options at all warns nothing', () => {
		assert.doesNotMatch(warningsFor('filter: { name: { _eq: x } }\n'), /read by nothing/);
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

// ---------------------------------------------------------------------------------------------
// peerDependencies — a reference to a collection NOTHING installed provides.
//
// This is the state a recipes module is opened in on its own, and it has to pass BOTH gates. It
// did not: compile stamped `unresolved_peers` onto every collection in the module and the
// `collections` meta-descriptor did not declare it, so `check` flagged compile's own output as an
// unknown field; and the generated module record's `peer_dependencies` was validated as a hard
// reference, so the absent peer dangled. There was no state in which an optional cross-module
// reference passed — dropping the declaration made compile fail instead, naming peerDependencies
// as the remedy.
describe('peerDependencies — an optional cross-module reference', () => {
	/** A module `blog` declaring `posts` as a peer: `comments` references it, `authors` does not. */
	const withPeerModule = (opts = {}) => {
		const ws = workspace(opts);
		const mod = path.join(ws.root, 'modules', 'blog');
		fs.mkdirSync(path.join(mod, 'collections'), { recursive: true });
		fs.writeFileSync(path.join(mod, 'package.json'), JSON.stringify({
			name: 'blog', private: true, version: '0.0.1', dreamteamer: { peerDependencies: ['posts'] },
		}));
		fs.writeFileSync(path.join(mod, 'collections', 'comments.collection.yaml'),
			'name: comments\ndescription: A comment on a post.\n'
			+ 'storage: { path: data/comments, codec: md, shape: file, suffix: comment }\n'
			+ 'id: { generate: "{{ title | slug }}" }\n'
			+ 'schema:\n  type: object\n  required: [title]\n  properties:\n'
			+ '    title: { type: string }\n    post: { type: string, x-reference: posts }\n'
			+ '    body: { type: string, format: markdown, x-body: true }\n');
		fs.writeFileSync(path.join(mod, 'collections', 'authors.collection.yaml'),
			'name: authors\ndescription: Someone who writes.\n'
			+ 'storage: { path: data/authors, codec: md, shape: file, suffix: author }\n'
			+ 'id: { generate: "{{ name | slug }}" }\n'
			+ 'schema:\n  type: object\n  required: [name]\n  properties:\n'
			+ '    name: { type: string }\n    body: { type: string, format: markdown, x-body: true }\n');
		return ws;
	};

	test('compiles clean AND checks clean — the whole point of declaring a peer', () => {
		const ws = withPeerModule();
		assert.equal(ws.dt('compile').code, 0);
		assert.equal(ws.dt('add', 'authors', '--name', 'Ada').code, 0);
		assert.equal(ws.dt('add', 'comments', '--title', 'First').code, 0);
		const res = dtCheck(ws.root);
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.match(res.stdout, /0 violations/);
	});

	test('a record that DOES point at the absent peer is warned about, never silent', () => {
		const ws = withPeerModule();
		assert.equal(ws.dt('compile').code, 0);
		// hand-written: the STORE still refuses a reference into a collection it cannot see, so this
		// is the state a module carries when its records were written where the peer WAS installed.
		fs.mkdirSync(path.join(ws.root, 'data', 'comments'), { recursive: true });
		fs.writeFileSync(path.join(ws.root, 'data', 'comments', 'first.comment.md'),
			'---\ntitle: First\npost: posts/hello\n---\n');
		const res = dtCheck(ws.root);
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.match(res.stdout, /peer collection "posts" is declared but not installed — 1 reference unresolvable/);
	});

	test('unresolved_peers lands only on the collections that actually reference the peer', () => {
		const ws = withPeerModule();
		assert.equal(ws.dt('compile').code, 0);
		const comments = load(readFile(ws.root, '.dreamteamer/collections/comments.collection.yaml'));
		const authors = load(readFile(ws.root, '.dreamteamer/collections/authors.collection.yaml'));
		assert.deepEqual(comments.unresolved_peers, ['posts']);
		assert.equal(authors.unresolved_peers, undefined,
			'a collection that references no peer must not carry the excuse for one');
	});

	test('the module record keeps peer_dependencies — it is the declaration, not a resolved link', () => {
		const ws = withPeerModule();
		assert.equal(ws.dt('compile').code, 0);
		const mod = load(readFile(ws.root, '.dreamteamer/modules/blog.module.yaml'));
		assert.deepEqual(mod.peer_dependencies, ['collections/posts']);
	});

	test('with the peer PRESENT the reference is hard again — a dangling target is flagged', () => {
		const ws = withPeerModule();
		const base = path.join(ws.root, 'modules', 'blogbase');
		fs.mkdirSync(path.join(base, 'collections'), { recursive: true });
		fs.writeFileSync(path.join(base, 'package.json'),
			JSON.stringify({ name: 'blogbase', private: true, version: '0.0.1', dreamteamer: {} }));
		fs.writeFileSync(path.join(base, 'collections', 'posts.collection.yaml'),
			'name: posts\ndescription: A post.\n'
			+ 'storage: { path: data/posts, codec: md, shape: file, suffix: post }\n'
			+ 'id: { generate: "{{ title | slug }}" }\n'
			+ 'schema:\n  type: object\n  required: [title]\n  properties:\n'
			+ '    title: { type: string }\n    body: { type: string, format: markdown, x-body: true }\n');
		assert.equal(ws.dt('compile').code, 0);
		assert.equal(load(readFile(ws.root, '.dreamteamer/collections/comments.collection.yaml')).unresolved_peers,
			undefined, 'nothing to excuse once the peer is installed');

		// hand-written, because the STORE refuses a dangling ref at write time — this is check's half
		fs.mkdirSync(path.join(ws.root, 'data', 'comments'), { recursive: true });
		fs.writeFileSync(path.join(ws.root, 'data', 'comments', 'first.comment.md'),
			'---\ntitle: First\npost: posts/nope\n---\n');
		const res = dtCheck(ws.root);
		assert.equal(res.code, 1);
		assert.match(res.stdout, /dangling reference "posts\/nope"/);
	});
});

// ---------------------------------------------------------------------------------------------
// A descriptor with no `storage.suffix` used to write every record as `<id>.undefined.md` —
// silent at compile, at `add` and at `check`, and on a `codec: file` collection every later verb
// then died inside `idFromRecordPath` on `undefined.replace`. compile DERIVES it instead, which is
// the rule `rename-collection` already assumes when it asks whether a suffix was derived.
describe('storage.suffix is derived, never left undefined', () => {
	test('a descriptor with a storage block but no suffix gets the singular of its name', () => {
		const ws = workspace({ collections: {
			widgets: simpleCollection({ storage: { path: 'data/widgets', codec: 'md', shape: 'file' } }),
		} });
		assert.equal(ws.store.descriptor('widgets').storage.suffix, 'widget');
		assert.equal(ws.dt('add', 'widgets', '--name', 'Sprocket').code, 0);
		assert.ok(readFile(ws.root, 'data/widgets/sprocket.widget.md'), 'the file carries the derived suffix');
	});

	test('a descriptor with NO storage block at all takes the same path', () => {
		const ws = workspace({ collections: { gadgets: simpleCollection() } });
		assert.equal(ws.store.descriptor('gadgets').storage.suffix, 'gadget');
		assert.equal(ws.dt('add', 'gadgets', '--name', 'Doohickey').code, 0);
		assert.ok(readFile(ws.root, 'data/gadgets/doohickey.gadget.md'));
	});

	test('a namespaced collection derives from the BARE name, not the qualified one', () => {
		const ws = workspace({ namespaces: ['shop'], collections: { 'shop/trolleys': simpleCollection() } });
		assert.equal(ws.store.descriptor('shop/trolleys').storage.suffix, 'trolley');
		assert.equal(ws.dt('add', 'shop/trolleys', '--name', 'Big One').code, 0);
		assert.ok(readFile(ws.root, 'data/shop/trolleys/big-one.trolley.md'));
	});

	test('an AUTHORED suffix always wins', () => {
		const ws = workspace({ collections: { widgets: simpleCollection({ storage: { suffix: 'thing' } }) } });
		assert.equal(ws.store.descriptor('widgets').storage.suffix, 'thing');
	});

	test('no record anywhere is written as <id>.undefined.<ext>', () => {
		const ws = workspace({ collections: { widgets: simpleCollection(), gadgets: simpleCollection() } });
		ws.dt('add', 'widgets', '--name', 'A');
		ws.dt('add', 'gadgets', '--name', 'B');
		assert.deepEqual(tree(ws.root, 'data').filter((f) => f.includes('.undefined.')), []);
	});
});
