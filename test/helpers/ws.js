// Tier-2 fixtures: a real workspace, on disk, compiled by the real compiler.
//
// SPEED IS THE DESIGN CONSTRAINT. `dreamteamer init` + `git init` + a first commit costs ~1s of
// subprocess time, and paying it per test would put the suite straight into the "run it in CI and
// ignore it" bucket. So it is paid ONCE into `test/.tmp/base`, keyed by a hash of the sources that
// decide what init produces, and every test gets a `cpSync` of that (~5ms). Change init.js or a core
// descriptor and the key changes and the base rebuilds itself — nobody has to remember to clear it.
//
// Everything here is deliberately synchronous. These are file and git operations in a throwaway
// directory; async would buy nothing and make every test body noisier.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { compile } from '../../src/compile.js';
import { Store } from '../../src/store.js';
import { dump } from '../../src/yaml.js';

export const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = path.join(ENGINE_ROOT, 'test', '.tmp');
const BIN = path.join(ENGINE_ROOT, 'bin', 'dreamteamer.js');

// A committer identity the container may not have configured. Passed as env rather than written into
// the fixture's git config so the fixture stays a plain clone of the base.
const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: 'dreamteamer test',
	GIT_AUTHOR_EMAIL: 'test@example.invalid',
	GIT_COMMITTER_NAME: 'dreamteamer test',
	GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

export function git(root, args) {
	return execFileSync('git', args, { cwd: root, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

/** What the cached base depends on. A miss rebuilds; a hit is a directory copy.
 *
 *  THIS FILE is in the hash too, and has to be: the base carries `.git/config`, `node_modules/` and a
 *  patched package.json that only this builder knows how to produce. Without it, changing how the base
 *  is built left every developer with a stale one that no key invalidated — which is how a fixture
 *  lacking a local git identity survived a fix to add one. */
function baseKey() {
	const h = createHash('sha256');
	h.update(fs.readFileSync(path.join(ENGINE_ROOT, 'src', 'init.js')));
	h.update(fs.readFileSync(fileURLToPath(import.meta.url)));
	for (const f of fs.readdirSync(path.join(ENGINE_ROOT, 'collections')).sort()) {
		h.update(f);
		h.update(fs.readFileSync(path.join(ENGINE_ROOT, 'collections', f)));
	}
	return h.digest('hex').slice(0, 12);
}

// `dreamteamer init` names the workspace module for its ROLE, not for the directory it runs in, so
// `modules/default/` is true for every fixture no matter what the cache key above it spells — which
// is why `writeCollection` can hardcode it. It used to be named after the directory, and the fixture
// had to be built inside a folder literally called `ws` to keep that hardcoding honest; that
// coupling is gone.
export const WS_MODULE = 'default';

let cachedBase;
function baseWorkspace() {
	if (cachedBase) return cachedBase;
	fs.mkdirSync(TMP, { recursive: true }); // first run, or after `npm test -- --clean`
	const holder = path.join(TMP, `base-${baseKey()}`);
	const stamp = path.join(holder, 'ready'); // OUTSIDE the copied tree, so it never lands in a fixture
	if (!fs.existsSync(stamp)) {
		// ⚠ BUILD IN A STAGING DIR AND RENAME IT INTO PLACE. Test files run in separate PROCESSES and
		// concurrently, so an in-process memo guards nothing and an `existsSync(stamp)` check is not
		// atomic: every worker raced to build the same base and all but one died on EEXIST creating the
		// symlink. `rename` IS atomic, so the loser simply discovers a finished base and uses it — and
		// because the stamp lives inside the staged tree, a half-built base can never be observed.
		const staging = fs.mkdtempSync(path.join(TMP, 'staging-'));
		buildBase(path.join(staging, WS_MODULE));
		fs.writeFileSync(path.join(staging, 'ready'), baseKey());
		try {
			fs.renameSync(staging, holder);
		} catch (e) {
			// ENOTEMPTY / EEXIST / EPERM all mean "another worker got there first", which is a success
			if (!['ENOTEMPTY', 'EEXIST', 'EPERM'].includes(e.code)) throw e;
			fs.rmSync(staging, { recursive: true, force: true });
		}
	}
	cachedBase = path.join(holder, WS_MODULE);
	return cachedBase;
}

function buildBase(dir) {
	fs.mkdirSync(dir, { recursive: true });
	// ⚠ `git init` FIRST, before `dreamteamer init`. `init` commits what it writes, and git walks
	// UPWARD to find a repo — so with no repo here it committed the whole fixture into the engine's
	// own history (three stray "dreamteamer: init workspace" commits, found only because .gitignore
	// failed to ignore an already-tracked path). Making the fixture a repo of its own first is what
	// contains it.
	git(dir, ['init', '-q']);
	// ⚠ A LOCAL IDENTITY, in the fixture's own .git/config, not just in GIT_ENV.
	//
	// `store.commit` runs git with no `env` option, so it inherits the TEST PROCESS's environment — which
	// does not carry the GIT_AUTHOR_*/GIT_COMMITTER_* vars `git()` passes to its own subprocesses. That
	// made every commit through the store depend on an ambient global identity: present on a developer
	// machine, absent on a CI runner. The whole suite passed locally and `auto-commit` tests failed in CI
	// with git's "please tell me who you are". Writing it into the repo config makes the fixture
	// self-contained, and it survives the per-test `cpSync` because .git comes along with it.
	git(dir, ['config', 'user.email', 'test@example.invalid']);
	git(dir, ['config', 'user.name', 'dreamteamer test']);
	// through the real binary, because "what a user gets from `dreamteamer init`" is the thing
	// every tier-2 test is implicitly asserting against
	const res = spawnSync(process.execPath, [BIN, 'init'], { cwd: dir, env: GIT_ENV, encoding: 'utf8' });
	if (res.status !== 0) throw new Error(`fixture init failed:\n${res.stdout}\n${res.stderr}`);
	// THE ENGINE AS AN INSTALLED MODULE — without this the fixture has no `collections`, `ui-views`,
	// `repos` or `modules` collection, because those are sources the engine CONTRIBUTES rather than
	// things init writes. A tier-2 workspace that lacks them is not the workspace anybody runs: the
	// first thing it fails to reproduce is `store.writableDescriptor` refusing a compiled source.
	//
	// A symlink, and the npm channel, because that is how a real workspace gets it (`npm i
	// dreamteamer` + a `dependencies` entry, which discoverModules requires). Pointing at the
	// checkout under test also means the fixture can never compile a DIFFERENT engine's descriptors
	// than the one the assertions run against.
	fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
	fs.symlinkSync(ENGINE_ROOT, path.join(dir, 'node_modules', 'dreamteamer'), 'dir');
	const pkgFile = path.join(dir, 'package.json');
	const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
	pkg.dependencies = { ...pkg.dependencies, dreamteamer: '*' };
	fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, '\t') + '\n');
	git(dir, ['add', '-A']);
	git(dir, ['commit', '-qm', 'fixture: init']);
}

const created = [];
process.on('exit', () => {
	if (process.env.DT_KEEP_FIXTURES) return; // debugging affordance: inspect the failing workspace
	for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * A fresh compiled workspace.
 *
 * @param {object} opts
 * @param {string[]} [opts.namespaces]   `dreamteamer.namespaces` in package.json
 * @param {object}   [opts.pkg]          extra keys merged into the `dreamteamer` section
 * @param {object}   [opts.collections]  name → descriptor object, written to the workspace module
 * @param {object}   [opts.records]      'collection' → [fields], added through the Store
 * @param {boolean}  [opts.compile]      set false to get an UNcompiled workspace (compile-error tests)
 */
export function workspace(opts = {}) {
	const base = baseWorkspace();
	const root = fs.mkdtempSync(path.join(TMP, 'ws-'));
	created.push(root);
	// dereference:false keeps `node_modules/dreamteamer` a LINK — dereferencing would copy the whole
	// engine checkout (node_modules included) into every fixture and make the suite unusably slow.
	fs.cpSync(base, root, { recursive: true, dereference: false, verbatimSymlinks: true });

	const pkgPath = path.join(root, 'package.json');
	const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	if (opts.namespaces) pkg.dreamteamer.namespaces = opts.namespaces;
	Object.assign(pkg.dreamteamer, opts.pkg ?? {});
	fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');

	for (const [name, descriptor] of Object.entries(opts.collections ?? {})) {
		writeCollection(root, name, descriptor);
	}

	const ws = { root, pkg };
	if (opts.compile === false) return { root, ws, git: (a) => git(root, a) };

	const out = compileQuietly(ws);
	const store = new Store(ws);
	for (const [collection, rows] of Object.entries(opts.records ?? {})) {
		for (const fields of rows) store.add(collection, { ...fields });
	}
	return { root, ws, store, out, git: (a) => git(root, a), dt: (...a) => dt(root, ...a) };
}

/**
 * Write a collection descriptor into the workspace module, at the path a real `collections add`
 * would use: `collections/health/doctors.collection.yaml`, mirroring the runtime layout.
 */
export function writeCollection(root, name, descriptor) {
	const file = path.join(root, 'modules', WS_MODULE, 'collections', `${name}.collection.yaml`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, dump({ name, ...descriptor }));
	return file;
}

/** A minimal valid descriptor, so a test only states the part it is about.
 *
 *  `notes` is here because it is what a real collection has and a relation TARGET must have: compile
 *  refuses to stamp a mirror onto a `codec: md` collection that declares no `x-body`, since a mirror
 *  write would rebuild the file from its parsed fields and drop any prose the record holds. A
 *  fixture without one could not be linked at all. */
export function simpleCollection(extra = {}) {
	return {
		id: { generate: '{{ name | slug }}' },
		schema: {
			type: 'object',
			required: ['name'],
			properties: { name: { type: 'string' }, notes: { type: 'string', format: 'markdown', 'x-body': true } },
		},
		...extra,
	};
}

/** compile(), with its chatter captured instead of printed. Returns {code, stdout, warnings}. */
export function compileQuietly(ws) {
	const stdout = [];
	const warnings = [];
	const log = console.log;
	const warn = console.warn;
	console.log = (...a) => stdout.push(a.join(' '));
	console.warn = (...a) => warnings.push(a.join(' '));
	try {
		const code = compile(ws);
		return { code, stdout, warnings };
	} finally {
		console.log = log;
		console.warn = warn;
	}
}

/** The compile error message for a workspace expected NOT to compile, or null if it compiled. */
export function compileError(ws) {
	try {
		compileQuietly(ws);
		return null;
	} catch (e) {
		return e.message;
	}
}

/** Run the real CLI in a workspace. Returns {code, stdout, stderr} — never throws on a non-zero exit. */
export function dt(root, ...args) {
	const res = spawnSync(process.execPath, [BIN, ...args], { cwd: root, env: GIT_ENV, encoding: 'utf8' });
	return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Read a file in a workspace as text, or null. */
export function readFile(root, rel) {
	try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; }
}

/**
 * A second module under `modules/<id>/`, the shape every real workspace has — a workspace's domain
 * collections live in modules, not at its root.
 *
 * `collections` is written FLAT-at-the-module-root (`modules/<id>/collections/<name>.collection.yaml`),
 * nested for a namespaced name, which is where compile enumerates them recursively and where
 * `schema-ops` derives the path from the collection's own name.
 */
export function writeModule(root, id, opts = {}) {
	const modRoot = path.join(root, 'modules', id);
	fs.mkdirSync(path.join(modRoot, 'collections'), { recursive: true });
	const dt = {};
	if (opts.description) dt.description = opts.description;
	if (opts.namespaces) dt.namespaces = opts.namespaces;
	if (opts.dependencies) dt.dependencies = opts.dependencies;
	if (opts.peerDependencies) dt.peerDependencies = opts.peerDependencies;
	if (opts.ownsData) dt['owns-data'] = true;
	fs.writeFileSync(
		path.join(modRoot, 'package.json'),
		JSON.stringify({ name: id, private: true, version: '0.0.1', files: ['collections', 'skills', 'agents', 'commands', 'command-bindings', 'ui-views', 'collection-templates'], dreamteamer: dt }, null, '\t') + '\n',
	);
	for (const [name, descriptor] of Object.entries(opts.collections ?? {})) {
		const file = path.join(modRoot, 'collections', `${name}.collection.yaml`);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, dump({ name, ...descriptor }));
	}
	return modRoot;
}

/** A `dreamteamer.<key>` edit on one module's package.json, for a fixture that needs to declare a
 *  dependency after the module already exists. */
export function patchModulePkg(root, id, patch) {
	const file = path.join(root, 'modules', id, 'package.json');
	const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
	pkg.dreamteamer = { ...pkg.dreamteamer, ...patch };
	fs.writeFileSync(file, JSON.stringify(pkg, null, '\t') + '\n');
}

/**
 * THE synthetic fixture for this whole wave: two domain modules plus the workspace module.
 *
 *   core  — people, teams, tasks (the shared nouns)
 *   hr    — hr/positions, in its OWN namespace, referencing core's `people` as a declared PEER
 *
 * ⚠ `hr` declares `peerDependencies: ['people']` rather than `dependencies: ['core']` on purpose:
 * a peer names a CONCEPT rather than a module, which is what lets `modules/hr` be copied alone into
 * a bare workspace and still compile — decision 130's acceptance test, which nothing had ever run.
 * A test that needs the hard edge adds it with `patchModulePkg`.
 *
 * Invented names throughout: this engine is published and the vault it is dogfooded on is not.
 */
export const CORE_COLLECTIONS = {
	people: {
		id: { generate: '{{ name | slug }}' },
		storage: { suffix: 'person' },
		description: 'A person this workspace knows about.',
		schema: {
			type: 'object',
			required: ['name'],
			properties: {
				name: { type: 'string' },
				employer: { type: 'string' },
				notes: { type: 'string', format: 'markdown', 'x-body': true },
			},
		},
	},
	teams: {
		id: { generate: '{{ name | slug }}' },
		storage: { suffix: 'team' },
		description: 'A group of people with a shared remit.',
		schema: {
			type: 'object',
			required: ['name'],
			properties: {
				name: { type: 'string' },
				notes: { type: 'string', format: 'markdown', 'x-body': true },
			},
		},
	},
	tasks: {
		id: { generate: '{{ name | slug }}' },
		storage: { suffix: 'task' },
		description: 'One concrete commitment.',
		schema: {
			type: 'object',
			required: ['name'],
			properties: {
				name: { type: 'string' },
				owner: { type: 'string', 'x-reference': 'people' },
				notes: { type: 'string', format: 'markdown', 'x-body': true },
			},
		},
	},
};

export const HR_COLLECTIONS = {
	'hr/positions': {
		id: { generate: '{{ name | slug }}' },
		storage: { suffix: 'position' },
		description: 'An open or filled role.',
		schema: {
			type: 'object',
			required: ['name'],
			properties: {
				name: { type: 'string' },
				holder: { type: 'string', 'x-reference': 'people' },
				notes: { type: 'string', format: 'markdown', 'x-body': true },
			},
		},
	},
};

export function twoModuleWorkspace(opts = {}) {
	const base = baseWorkspace();
	const root = fs.mkdtempSync(path.join(TMP, 'ws2-'));
	created.push(root);
	fs.cpSync(base, root, { recursive: true, dereference: false, verbatimSymlinks: true });

	writeModule(root, 'core', { description: 'The shared nouns.', collections: CORE_COLLECTIONS });
	writeModule(root, 'hr', {
		description: 'Roles and headcount.',
		// §8: THE MODULE declares the namespace it owns, so `modules/hr` can be copied alone into a
		// bare workspace and compile — decision 130's gate, which was unpassable while namespaces
		// were workspace-only.
		namespaces: ['hr'],
		peerDependencies: ['people'],
		collections: HR_COLLECTIONS,
	});

	const pkgPath = path.join(root, 'package.json');
	const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	// The workspace declares NOTHING by default now. A test that wants the duplicate-declaration
	// warning passes `namespaces` explicitly.
	if (opts.namespaces) pkg.dreamteamer.namespaces = opts.namespaces;
	else delete pkg.dreamteamer.namespaces;
	Object.assign(pkg.dreamteamer, opts.pkg ?? {});
	fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');

	for (const [name, descriptor] of Object.entries(opts.collections ?? {})) {
		writeCollection(root, name, descriptor);
	}

	// ⚠ COMMIT THE MODULES, as `buildBase` commits the base. A real workspace's module sources are in
	// git, and a source write is gated by `git add -- <path>` — which FAILS OUTRIGHT on a pathspec
	// that is neither on disk nor in the index. So an UNcommitted descriptor made `rm-collection` roll
	// back on a file git simply did not care about, and the fixture, not the verb, was the liar.
	git(root, ['add', '--', 'modules', 'package.json']);
	git(root, ['commit', '-qm', 'fixture: two modules']);

	const ws = { root, pkg };
	if (opts.compile === false) return { root, ws, git: (a) => git(root, a), dt: (...a) => dt(root, ...a) };
	const out = compileQuietly(ws);
	const store = new Store(ws);
	for (const [collection, rows] of Object.entries(opts.records ?? {})) {
		for (const fields of rows) store.add(collection, { ...fields });
	}
	return { root, ws, store, out, git: (a) => git(root, a), dt: (...a) => dt(root, ...a) };
}

/** Every workspace-relative file path under a directory, sorted — for asserting on layout. */
export function tree(root, rel = '.') {
	const start = path.join(root, rel);
	if (!fs.existsSync(start)) return [];
	const out = [];
	const walk = (dir) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (e.name.startsWith('.')) continue;
			const p = path.join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else out.push(path.relative(root, p).split(path.sep).join('/'));
		}
	};
	walk(start);
	return out;
}

/**
 * ONE MODULE, ALONE, IN A VIRGIN WORKSPACE — decision 130's acceptance test, which nothing has ever
 * run.
 *
 * "A module compiles alone in a bare workspace" was the self-containment rule from the day modules
 * existed, and it was UNPASSABLE for any namespaced module: namespaces were declared by the
 * workspace only, so the consuming workspace had to edit its own manifest before the module would
 * compile — which is exactly the coupling the rule forbids. §8 reverses that, and this is the
 * fixture that proves it.
 *
 * The module is COPIED, not linked: recipes modules are copied rather than installed (decision 129),
 * so copying is what a consumer actually does.
 */
export function bareWorkspace(sourceRoot, moduleId) {
	const base = baseWorkspace();
	const root = fs.mkdtempSync(path.join(TMP, 'bare-'));
	created.push(root);
	fs.cpSync(base, root, { recursive: true, dereference: false, verbatimSymlinks: true });
	// A virgin workspace declares NOTHING: no namespaces, no dependencies, no disable entries. That
	// is the whole point — anything the module needs, the module has to carry.
	const pkgPath = path.join(root, 'package.json');
	const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	delete pkg.dreamteamer.namespaces;
	fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');
	fs.cpSync(path.join(sourceRoot, 'modules', moduleId), path.join(root, 'modules', moduleId), { recursive: true });
	git(root, ['add', '--', 'modules', 'package.json']);
	git(root, ['commit', '-qm', `fixture: ${moduleId} alone`]);
	return {
		root,
		ws: { root, pkg },
		dt: (...a) => dt(root, ...a),
		git: (a) => git(root, a),
	};
}
