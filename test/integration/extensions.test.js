// Tier 2 — the EXTENSION seam, end to end through the real binary. Every optional tool (workflows,
// http, notebooklm) stands on exactly these contributions, so each one is pinned here against a
// synthetic extension rather than against any of them: core must not learn a tool's name to work.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, readFile, git, dt, compileQuietly, compileError, WS_MODULE } from '../helpers/ws.js';
import { dump } from '../../src/yaml.js';
import { openWorkspace } from '../../src/api.js';

const PROBES = {
	name: 'probes',
	description: 'A claim about an artifact, judged at compile.',
	storage: { path: 'probes', codec: 'yaml', shape: 'file', suffix: 'probe' },
	id: { generate: '{{ name | slug }}' },
	schema: { type: 'object', required: ['name', 'about'], properties: { name: { type: 'string' }, about: { type: 'string' } } },
};

// The extension's entry. `activate` receives the engine API — the test asserts it is THIS engine's.
const ENTRY = `
export const apiVersion = 1;
export default function activate(dt) {
	return {
		commands: {
			hello: {
				usage: '  hello <words…>   say hello (probe-kit)',
				run(ws, argv) {
					console.log('hello ' + argv.join(' ') + ' from ' + ws.root + ' engine ' + dt.engineVersion() + ' ext ' + ws.extensions.map((e) => e.name).join(','));
					return 3;
				},
			},
		},
		sourceKinds: [{ kind: 'probes', exclude: ['fixtures'] }],
		analyze(draft) {
			const errors = [], notes = [];
			const skills = new Set([...draft.entries.keys()].filter((k) => k.startsWith('skills/')).map((k) => k.split('/')[1]));
			let n = 0;
			for (const rt of draft.entries.keys()) {
				if (!rt.startsWith('probes/')) continue;
				n++;
				const p = draft.parse(rt);
				if (!skills.has(String(p.about).replace(/^skills\\//, ''))) errors.push(rt + ': about names no skill (' + p.about + ')');
			}
			if (!draft.descriptors.has('probes')) errors.push('the probes descriptor is not in the draft');
			notes.push('probes: ' + n + ' declared');
			return { errors, notes };
		},
		harnesses: {
			demo: (ctx) => ({ blocks: { 'DEMO.md': 'demo config for ' + ctx.collections.filter((c) => !c.generated).length + ' collections' }, summary: 'demo → DEMO.md block' }),
		},
		orientation: 'probe-kit is installed: every skill here has a probe under probes/.',
		hooks: { WorktreeCreate: 'hello --hook' },
	};
}
`;

function install(root, { name = 'probe-kit', entry = ENTRY, descriptor = PROBES, extensionKey = './ext.js' } = {}) {
	const dir = path.join(root, 'node_modules', name);
	fs.mkdirSync(path.join(dir, 'collections'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.2.3', description: 'A test extension.', dreamteamer: { extension: extensionKey } }));
	fs.writeFileSync(path.join(dir, 'ext.js'), entry);
	if (descriptor) fs.writeFileSync(path.join(dir, 'collections', `${descriptor.name}.collection.yaml`), dump(descriptor));
	const pkgFile = path.join(root, 'package.json');
	const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
	pkg.dependencies = { ...pkg.dependencies, [name]: '*' };
	fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, '\t') + '\n');
	return dir;
}

const probe = (root, id, about, sub = '') => {
	const file = path.join(root, 'modules', WS_MODULE, 'probes', sub, `${id}.probe.yaml`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, dump({ name: id, about }));
	return file;
};

function withKit(opts = {}) {
	const ws = workspace({ compile: false, pkg: { harnesses: ['claude-code', 'demo'] } });
	install(ws.root, opts);
	fs.mkdirSync(path.join(ws.root, 'modules', WS_MODULE, 'skills', 'greet'), { recursive: true });
	fs.writeFileSync(path.join(ws.root, 'modules', WS_MODULE, 'skills', 'greet', 'SKILL.md'), '---\nname: greet\ndescription: "use when greeting"\n---\n\nSay hi.\n');
	probe(ws.root, 'greets', 'skills/greet');
	probe(ws.root, 'ignored', 'skills/nope', 'fixtures'); // a fixture: never staged, never judged
	git(ws.root, ['add', '-A']); git(ws.root, ['commit', '-qm', 'fixture: probe-kit']);
	return { ...ws, dt: (...a) => dt(ws.root, ...a) };
}

describe('an extension\'s command runs in-process, handed THIS workspace and THIS engine', () => {
	test('dt <verb> dispatches, and its return value is the exit code', () => {
		const ws = withKit();
		const res = ws.dt('hello', 'a', 'b');
		assert.equal(res.code, 3, res.stderr);
		assert.ok(res.stdout.includes(`hello a b from ${ws.root}`) || res.stdout.includes(`hello a b from ${fs.realpathSync(ws.root)}`), res.stdout);
		const version = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
		assert.match(res.stdout, new RegExp(`engine ${version.replace(/\./g, '\\.')} ext probe-kit`));
	});

	test('dt help lists it under its package, and dt status names it', () => {
		const ws = withKit();
		const help = ws.dt('help');
		assert.equal(help.code, 0);
		assert.match(help.stdout, /installed extensions:\nprobe-kit@1\.2\.3:\n {2}hello <words…>/);
		assert.equal(ws.dt('compile').code, 0);
		assert.match(ws.dt('status').stdout, /extensions: probe-kit@1\.2\.3/);
	});

	test('a moved core verb with no extension to answer it says so, exit 2 — and names no unpublished package', () => {
		const ws = workspace();
		for (const verb of ['prove', 'setup', 'notebooklm']) {
			const r = ws.dt(verb, 'x');
			assert.equal(r.code, 2, verb);
			assert.match(r.stderr, new RegExp(`\`dt ${verb}\` left core in 0\\.31\\.0 and returns as an extension, which is not published yet`));
			assert.doesNotMatch(r.stderr, /@dreamteamer\//, 'an install line for a package that is not on npm');
		}
	});
});

describe('a contributed source kind compiles like a built-in one', () => {
	test('it is staged into the runtime, its excluded subtree is not, and the manifest records both', () => {
		const ws = withKit();
		const r = ws.dt('compile');
		assert.equal(r.code, 0, r.stderr);
		assert.ok(fs.existsSync(path.join(ws.root, '.dreamteamer', 'probes', 'greets.probe.yaml')));
		assert.ok(!fs.existsSync(path.join(ws.root, '.dreamteamer', 'probes', 'fixtures')), 'the fixture subtree was staged');
		const manifest = readFile(ws.root, '.dreamteamer/manifest.yaml');
		assert.match(manifest, /source-kinds:\n {2}- kind: probes\n {4}exclude:\n {6}- fixtures\n {4}extension: probe-kit/);
		assert.match(manifest, /extensions:\n {2}- name: probe-kit\n {4}version: 1\.2\.3/);
		// the note prints after the summary; the list verb reads it as a runtime collection
		assert.match(r.stdout, /probes: 1 declared/);
		const list = ws.dt('list', 'probes');
		assert.equal(list.code, 0, list.stderr);
		assert.match(list.stdout, /^greets/m);
		assert.equal(ws.dt('check').code, 0);
	});

	test('staleness walks the contributed kind — and skips its fixtures', () => {
		const ws = withKit();
		assert.equal(ws.dt('compile').code, 0);
		probe(ws.root, 'ignored2', 'skills/nope', 'fixtures');
		assert.match(ws.dt('status').stdout, /is fresh/, 'a new fixture file made the runtime stale');
		probe(ws.root, 'second', 'skills/greet');
		const s = ws.dt('status');
		assert.match(s.stdout, /second\.probe\.yaml \(new, uncompiled\)/);
	});

	test('the system verbs work on it with no core knowledge of its name — rm derives the file shape', () => {
		const ws = withKit();
		assert.equal(ws.dt('compile').code, 0);
		const r = ws.dt('rm', 'probes/greets');
		assert.equal(r.code, 0, r.stderr + r.stdout);
		assert.ok(!fs.existsSync(path.join(ws.root, 'modules', WS_MODULE, 'probes', 'greets.probe.yaml')));
		assert.equal(ws.dt('list', 'probes').stdout.trim(), '(no probes)');
	});

	test('WITHOUT the extension a probes/ folder is an unknown kind — never compiled unjudged', () => {
		const ws = workspace({ compile: false });
		fs.mkdirSync(path.join(ws.root, 'modules', WS_MODULE, 'probes'), { recursive: true });
		probe(ws.root, 'orphan', 'skills/x');
		fs.writeFileSync(path.join(ws.root, 'modules', WS_MODULE, 'package.json'), JSON.stringify({ name: WS_MODULE, dreamteamer: {} }));
		const err = compileError(ws.ws);
		// the workspace module is inline at modules/default, so its root is enumerated
		assert.match(err ?? '', /not a known kind: probes/);
	});
});

describe('analyze judges the assembled compile BEFORE any output is replaced', () => {
	test('an error fails compile and the previous runtime stands', () => {
		const ws = withKit();
		assert.equal(ws.dt('compile').code, 0);
		const before = readFile(ws.root, '.dreamteamer/manifest.yaml');
		probe(ws.root, 'broken', 'skills/greter');
		const r = ws.dt('compile');
		assert.equal(r.code, 1);
		assert.match(r.stderr, /probes\/broken\.probe\.yaml: about names no skill \(skills\/greter\)/);
		assert.equal(readFile(ws.root, '.dreamteamer/manifest.yaml'), before, 'a failed analysis replaced the runtime');
		assert.ok(!fs.existsSync(path.join(ws.root, '.dreamteamer', 'probes', 'broken.probe.yaml')));
	});

	test('a SCHEMA write compiles through the same contribution, so it is refused and rolled back too', () => {
		const ws = withKit();
		assert.equal(ws.dt('compile').code, 0);
		probe(ws.root, 'broken', 'skills/greter');
		git(ws.root, ['add', '-A']); git(ws.root, ['commit', '-qm', 'a broken probe']);
		const desc = path.join(ws.root, 'modules', WS_MODULE, 'collections', 'notes.collection.yaml');
		const bytes = fs.readFileSync(desc, 'utf8');
		const r = ws.dt('add-field', 'notes', '--name', 'mood', '--type', 'string');
		assert.notEqual(r.code, 0, 'the gate compile ignored the extension');
		assert.match(r.stderr, /about names no skill/);
		assert.equal(fs.readFileSync(desc, 'utf8'), bytes, 'the refused write left the source changed');
	});
});

describe('harness, orientation and hook contributions', () => {
	test('a contributed harness writes its block; uninstalling the extension removes the block and the kind', () => {
		const ws = withKit();
		assert.equal(ws.dt('compile').code, 0);
		assert.match(readFile(ws.root, 'DEMO.md'), /<!-- dreamteamer:begin[^\n]*\ndemo config for \d+ collections\n<!-- dreamteamer:end -->/);
		fs.appendFileSync(path.join(ws.root, 'DEMO.md'), '\nmy own notes\n');
		// uninstall: the dependency and its probes go
		const pkgFile = path.join(ws.root, 'package.json');
		const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
		delete pkg.dependencies['probe-kit'];
		fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, '\t') + '\n');
		fs.rmSync(path.join(ws.root, 'modules', WS_MODULE, 'probes'), { recursive: true });
		const r = ws.dt('compile');
		assert.equal(r.code, 0, r.stderr);
		assert.match(r.stderr, /unknown harness "demo"/);
		const demo = readFile(ws.root, 'DEMO.md');
		assert.doesNotMatch(demo ?? '', /dreamteamer:begin/, 'the orphaned block survived the uninstall');
		assert.match(demo, /my own notes/, 'the operator\'s own text in the file was lost');
		assert.ok(!fs.existsSync(path.join(ws.root, '.dreamteamer', 'probes')), 'the uninstalled kind\'s compiled folder was left behind');
	});

	test('the orientation paragraph and the contributed kind reach every orientation block', () => {
		const ws = withKit();
		assert.equal(ws.dt('compile').code, 0);
		const claude = readFile(ws.root, 'CLAUDE.md');
		assert.match(claude, /probe-kit is installed: every skill here has a probe under probes\//);
		assert.match(claude, /`collection-templates\/`, `probes\/`/);
	});

	test('a contributed hook is merged into --print-adapters beside core\'s', () => {
		const ws = withKit();
		const r = ws.dt('install', '--print-adapters');
		assert.equal(r.code, 0, r.stderr);
		const hooks = JSON.parse(r.stdout).hooks;
		assert.deepEqual(Object.keys(hooks), ['SessionStart', 'WorktreeCreate']);
		assert.match(hooks.WorktreeCreate[0].hooks[0].command, /dt-hook\.sh" hello --hook$/);
	});
});

describe('the loader refuses what it cannot honour — at open, by name', () => {
	test('a verb core owns', async () => {
		const ws = workspace({ compile: false });
		install(ws.root, { entry: 'export default () => ({ commands: { list: { run() { return 0; } } } });' });
		await assert.rejects(openWorkspace(ws.root), /contributes the command "list", which the engine already owns/);
	});

	test('two extensions claiming one kind', async () => {
		const ws = workspace({ compile: false });
		install(ws.root, { name: 'kit-a', entry: "export default () => ({ sourceKinds: ['gizmos'] });", descriptor: null });
		install(ws.root, { name: 'kit-b', entry: "export default () => ({ sourceKinds: ['gizmos'] });", descriptor: null });
		await assert.rejects(openWorkspace(ws.root), /kit-b contributes the kind "gizmos", which kit-a already owns/);
	});

	test('an unknown contribution key, an entry that will not load, a newer API', async () => {
		const a = workspace({ compile: false });
		install(a.root, { entry: 'export default () => ({ comands: {} });' });
		await assert.rejects(openWorkspace(a.root), /unknown key "comands"/);
		const b = workspace({ compile: false });
		install(b.root, { entry: 'export default () => ({}); syntax error here' });
		await assert.rejects(openWorkspace(b.root), /probe-kit: its entry node_modules\/probe-kit\/ext\.js did not load/);
		const c = workspace({ compile: false });
		install(c.root, { entry: 'export const apiVersion = 2; export default () => ({});' });
		await assert.rejects(openWorkspace(c.root), /targets extension API 2/);
	});

	test('a DISABLED extension is not loaded, and a transitive one never is', async () => {
		const ws = workspace({ compile: false, pkg: { disable: ['probe-kit'] } });
		install(ws.root);
		assert.deepEqual((await openWorkspace(ws.root)).extensions, []);
		const t = workspace({ compile: false });
		install(t.root);
		const pkg = JSON.parse(fs.readFileSync(path.join(t.root, 'package.json'), 'utf8'));
		delete pkg.dependencies['probe-kit']; // present in node_modules, not a direct dependency
		fs.writeFileSync(path.join(t.root, 'package.json'), JSON.stringify(pkg));
		assert.deepEqual((await openWorkspace(t.root)).extensions, []);
	});

	test('compile without the handle\'s extensions sees a core-only workspace (compileQuietly is the raw function)', () => {
		const ws = withKit();
		fs.rmSync(path.join(ws.root, 'modules', WS_MODULE, 'probes'), { recursive: true });
		const out = compileQuietly(ws.ws);
		assert.equal(out.code, 0);
		assert.ok(!fs.existsSync(path.join(ws.root, '.dreamteamer', 'probes')));
	});
});

describe('what left core is refused where it would otherwise mislead', () => {
	test('a descriptor still declaring storage.driver is a compile error, not a writable folder of fake host records', () => {
		const ws = workspace({ compile: false, collections: { containers: { storage: { driver: 'docker' }, schema: { type: 'object', properties: { name: { type: 'string' } } } } } });
		assert.match(compileError(ws.ws) ?? '', /collection "containers": storage\.driver is gone since 0\.31\.0/);
	});
});

describe('a SCOPED extension can be switched off with dreamteamer.disable (review F5)', () => {
	// activation writes a marker, so "never activated" is observable rather than inferred
	const scoped = (disable) => {
		const ws = workspace({ compile: false, pkg: disable ? { disable } : {} });
		const dir = install(ws.root, { name: '@test/scoped', entry: `export default async () => { (await import('node:fs')).writeFileSync(process.env.DT_TEST_MARKER, 'activated'); return { commands: { scopedverb: { run() { return 0; } } }, sourceKinds: ['gizmos'] }; };` });
		return { ws, dir };
	};
	for (const spelling of ['@test/scoped', 'scoped']) {
		test(`disabled as "${spelling}": never activated, and its content module is not compiled`, async () => {
			const { ws } = scoped([spelling]);
			const marker = path.join(ws.root, 'activated.txt');
			process.env.DT_TEST_MARKER = marker;
			try {
				assert.deepEqual((await openWorkspace(ws.root)).extensions, []);
				assert.ok(!fs.existsSync(marker), 'activate() ran for a disabled extension');
			} finally { delete process.env.DT_TEST_MARKER; }
			const r = dt(ws.root, 'compile');
			assert.equal(r.code, 0, r.stderr);
			assert.ok(!fs.existsSync(path.join(ws.root, '.dreamteamer', 'collections', 'probes.collection.yaml')), 'the disabled package\'s collection was compiled');
			assert.doesNotMatch(r.stderr, /matched nothing/, 'the disable entry was reported as matching nothing');
		});
	}
	test('re-enabled, it activates again with its verbs and kinds', async () => {
		const { ws } = scoped(null);
		const marker = path.join(ws.root, 'activated.txt');
		process.env.DT_TEST_MARKER = marker;
		try {
			const handle = await openWorkspace(ws.root);
			assert.deepEqual(handle.extensions.map((e) => e.name), ['@test/scoped']);
			assert.ok('scopedverb' in handle.extensions[0].commands);
			assert.deepEqual(handle.extensions[0].sourceKinds.map((k) => k.kind), ['gizmos']);
			assert.ok(fs.existsSync(marker));
		} finally { delete process.env.DT_TEST_MARKER; }
	});
	test('an entity-level entry is still an entity, not a package', async () => {
		const { ws } = scoped(['@test/scoped/probes']);
		process.env.DT_TEST_MARKER = path.join(ws.root, 'activated.txt');
		try { assert.equal((await openWorkspace(ws.root)).extensions.length, 1); } finally { delete process.env.DT_TEST_MARKER; }
	});
});

describe('a contributed harness that throws leaves the last good runtime untouched (review F7)', () => {
	const ENTRY2 = `export default () => ({ harnesses: {
		good: () => ({ blocks: { 'GOOD.md': 'good config' } }),
		bad: () => { throw new Error('renderer unavailable'); },
	} });`;
	test('the compile is refused, and the manifest, every descriptor and every harness file are byte-for-byte unchanged', () => {
		const ws = workspace({ compile: false, pkg: { harnesses: ['claude-code', 'good'] } });
		install(ws.root, { entry: ENTRY2, descriptor: null });
		assert.equal(dt(ws.root, 'compile').code, 0);
		fs.writeFileSync(path.join(ws.root, 'GOOD.md'), 'my own text above\n\n' + readFile(ws.root, 'GOOD.md') + '\nmy own text below\n');
		const files = ['.dreamteamer/manifest.yaml', '.dreamteamer/collections/notes.collection.yaml', 'CLAUDE.md', 'GOOD.md'];
		const before = Object.fromEntries(files.map((f) => [f, readFile(ws.root, f)]));
		// a source change that WOULD rewrite a descriptor, and the throwing harness switched on after the good one
		const src = path.join(ws.root, 'modules', WS_MODULE, 'collections', 'notes.collection.yaml');
		fs.writeFileSync(src, fs.readFileSync(src, 'utf8').replace(/^description: .*$/m, 'description: A changed sentence.'));
		const pkgFile = path.join(ws.root, 'package.json');
		const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
		pkg.dreamteamer.harnesses = ['claude-code', 'good', 'bad'];
		fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, '\t') + '\n');
		const r = dt(ws.root, 'compile');
		assert.equal(r.code, 1);
		assert.match(r.stderr, /extension probe-kit: harness "bad" failed — renderer unavailable/);
		for (const f of files) assert.equal(readFile(ws.root, f), before[f], `${f} changed under a refused compile`);
		// corrected: one compile brings everything forward together
		pkg.dreamteamer.harnesses = ['claude-code', 'good'];
		fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, '\t') + '\n');
		assert.equal(dt(ws.root, 'compile').code, 0);
		assert.match(readFile(ws.root, '.dreamteamer/collections/notes.collection.yaml'), /A changed sentence/);
		assert.notEqual(readFile(ws.root, '.dreamteamer/manifest.yaml'), before['.dreamteamer/manifest.yaml']);
		assert.match(readFile(ws.root, 'GOOD.md'), /^my own text above[\s\S]*good config[\s\S]*my own text below\n$/);
	});
});


describe('disabling a PACKAGE OF MODULES switches off its code and every module it bundles (review R4)', () => {
	const CRATES = { name: 'crates', description: 'A crate.', storage: { path: 'crates', codec: 'yaml', shape: 'file', suffix: 'crate' },
		id: { generate: '{{ name | slug }}' }, schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } };
	const bundle = (disable) => {
		const ws = workspace({ compile: false, pkg: disable ? { disable } : {} });
		const dir = install(ws.root, { name: '@test/bundle', descriptor: null, entry: `export default async () => { if (process.env.DT_TEST_MARKER) (await import('node:fs')).writeFileSync(process.env.DT_TEST_MARKER, 'activated'); return { commands: { bundleverb: { run() { return 0; } } } }; };` });
		const child = path.join(dir, 'modules', 'crates');
		fs.mkdirSync(path.join(child, 'collections'), { recursive: true });
		fs.writeFileSync(path.join(child, 'package.json'), JSON.stringify({ name: 'crates', version: '1.0.0', dreamteamer: { description: 'Crates.' } }));
		fs.writeFileSync(path.join(child, 'collections', 'crates.collection.yaml'), dump(CRATES));
		return ws;
	};
	const crates = (ws) => path.join(ws.root, '.dreamteamer', 'collections', 'crates.collection.yaml');
	const opened = async (ws) => {
		process.env.DT_TEST_MARKER = path.join(ws.root, 'activated.txt');
		try { return (await openWorkspace(ws.root)).extensions.map((e) => e.name); } finally { delete process.env.DT_TEST_MARKER; }
	};
	for (const spelling of ['@test/bundle', 'bundle']) {
		test(`disabled as "${spelling}": not activated, no bundled module compiled, and the entry matched`, async () => {
			const ws = bundle([spelling]);
			assert.deepEqual(await opened(ws), []);
			const r = dt(ws.root, 'compile');
			assert.equal(r.code, 0, r.stderr);
			assert.ok(!fs.existsSync(crates(ws)), 'a module bundled by the disabled package was compiled');
			assert.doesNotMatch(r.stderr, /matched nothing/);
		});
	}
	test('re-enabled, the extension activates and its bundled module compiles', async () => {
		const ws = bundle(null);
		assert.deepEqual(await opened(ws), ['@test/bundle']);
		const r = dt(ws.root, 'compile');
		assert.equal(r.code, 0, r.stderr);
		assert.ok(fs.existsSync(crates(ws)));
	});
	test('a git_modules bundle follows the same rule — the root name disables its children', async () => {
		const { discoverModules } = await import('../../src/compile.js');
		const ws = workspace({ compile: false });
		const child = path.join(ws.root, 'git_modules', 'gitbundle', 'modules', 'crates');
		fs.mkdirSync(child, { recursive: true });
		fs.writeFileSync(path.join(ws.root, 'git_modules', 'gitbundle', 'package.json'), JSON.stringify({ name: 'gitbundle', dreamteamer: {} }));
		fs.writeFileSync(path.join(child, 'package.json'), JSON.stringify({ name: 'crates', dreamteamer: {} }));
		const names = (disable) => discoverModules(ws.root, { ...ws.ws.pkg, dreamteamer: { ...ws.ws.pkg.dreamteamer, disable } });
		assert.ok(names([]).modules.some((m) => m.name === 'crates'));
		const off = names(['gitbundle']);
		assert.ok(!off.modules.some((m) => m.name === 'crates'));
		assert.deepEqual(off.disabledModules, ['gitbundle']);
	});
	test('disabling only the CHILD keeps the extension and drops that module', async () => {
		const ws = bundle(['crates']);
		assert.deepEqual(await opened(ws), ['@test/bundle']);
		const r = dt(ws.root, 'compile');
		assert.equal(r.code, 0, r.stderr);
		assert.ok(!fs.existsSync(crates(ws)));
		assert.doesNotMatch(r.stderr, /matched nothing/);
	});
});

describe('a WORKSPACE module can carry an extension entry — no package, no npm (inline extensions)', () => {
	const inline = (root, { id = 'kit', entry, disable } = {}) => {
		const dir = path.join(root, 'modules', id);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: id, version: '0.0.1', dreamteamer: { description: 'An inline kit.', extension: './ext.js' } }));
		fs.writeFileSync(path.join(dir, 'ext.js'), entry ?? `export default () => ({ commands: { inlinehello: { usage: '  inlinehello   say hi', run(ws, argv) { console.log('inline hello ' + argv.join(' ')); return 0; } } }, sourceKinds: ['gizmos'] });`);
		if (disable) {
			const pkgFile = path.join(root, 'package.json');
			const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
			pkg.dreamteamer = { ...pkg.dreamteamer, disable };
			fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, '\t') + '\n');
		}
		return dir;
	};
	test('it activates: its verb runs, its kind compiles, and the manifest names it', async () => {
		const ws = workspace({ compile: false });
		inline(ws.root);
		const gizmo = path.join(ws.root, 'modules', WS_MODULE, 'gizmos', 'one.yaml');
		fs.mkdirSync(path.dirname(gizmo), { recursive: true });
		fs.writeFileSync(gizmo, 'name: one\n');
		assert.deepEqual((await openWorkspace(ws.root)).extensions.map((e) => e.name), ['kit']);
		const r = dt(ws.root, 'inlinehello', 'there');
		assert.equal(r.code, 0, r.stderr);
		assert.match(r.stdout, /inline hello there/);
		const c = dt(ws.root, 'compile');
		assert.equal(c.code, 0, c.stderr);
		assert.match(readFile(ws.root, '.dreamteamer/manifest.yaml'), /extensions:\n {2}- name: kit/);
		assert.ok(fs.existsSync(path.join(ws.root, '.dreamteamer', 'gizmos', 'one.yaml')));
	});
	test('dreamteamer.disable switches it off like any module', async () => {
		const ws = workspace({ compile: false });
		inline(ws.root, { disable: ['kit'] });
		assert.deepEqual((await openWorkspace(ws.root)).extensions, []);
	});
	test('an inline module shadows the npm package of the same name — its code loads, the package\'s does not', async () => {
		const ws = workspace({ compile: false });
		install(ws.root, { name: 'kit', descriptor: null, entry: 'export default () => { throw new Error("the shadowed npm copy was activated"); };' });
		inline(ws.root);
		const h = await openWorkspace(ws.root);
		assert.deepEqual(h.extensions.map((e) => e.name), ['kit']);
		assert.ok('inlinehello' in h.extensions[0].commands);
	});
});
