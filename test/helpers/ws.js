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
