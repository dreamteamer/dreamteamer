// schema operations — source-writing mutations shared by the CLI meta verbs and the
// server's schema endpoints. the contract (audit finding 11, clean-room bug 2): an op
// writes sources, proves them with a REAL compile, and only then commits — an
// uncompilable source can never land in history. the successful gate compile also
// leaves the runtime fresh, which kills the add-field-right-after-collections-add
// papercut (review finding 7): schema ops ARE explicit compiles.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { load, dump, writeSource, commentCount } from './yaml.js';
import { compile, kindDir, titleCase, KINDS, repoRootOf } from './compile.js';
import { readManifest, runtimeKindDir } from './runtime.js';
import { normalizeNamespaces, namespaceOf, baseNameOf, qualify, defaultStoragePath, singular } from './namespace.js';
import { refTargetsOf } from './ref.js';

// Same rule as store.js: a git failure we CATCH must not also print git's own error on top of the
// clean message we throw. stdout stays piped because some callers read it.
const GIT_QUIET = ['ignore', 'pipe', 'ignore'];
import { walk, idFromRecordPath, parseRecord } from './records.js';
import { Store, bodyField, serialize, atomicWrite } from './store.js';

// ---- the gate -------------------------------------------------------------------

/**
 * A SOURCE WRITE MAY NOT SILENTLY LOSE A COMMENT — the invariant that would have caught the
 * re-serialization bug on the first rename instead of the twenty-seventh.
 *
 * A module source is where this project writes down WHY a collection exists, and every gate it had
 * was blind to losing that: the schema is unchanged, so `compile` and `check` both stay green while
 * the reasoning is deleted. Counting comment lines is crude on purpose — it is structural, it costs
 * one pass over bytes already in hand, and it fails the op rather than reporting it afterwards.
 *
 * ⚠ THE OPT-OUT IS REAL AND NARROW. `remove-field` takes the comment ABOVE the field with the field,
 * which is the correct outcome and a decrease; so does deleting a file. Those ops say so explicitly
 * (`commentsMayDecrease`) rather than being exempted by a heuristic that would also excuse a bug.
 */
function assertCommentsKept(ws, snapshots) {
	for (const { f, prev } of snapshots) {
		if (prev === null || !fs.existsSync(f)) continue;
		const before = commentCount(prev.toString('utf8'));
		const after = commentCount(fs.readFileSync(f, 'utf8'));
		if (after >= before) continue;
		throw new Error(`${path.relative(ws.root, f)} would lose ${before - after} comment line(s) — a source write may not delete a module's own reasoning. Nothing was changed.`);
	}
}

function writeGated(ws, store, files, subject, mutate, after, { commentsMayDecrease = false } = {}) {
	// same guarantees as record writes (docs-audit catch): the STORE's cross-process lock
	// serializes schema ops too, and a failed git commit rolls the source back — a schema
	// op fails closed exactly like a record mutation.
	return store.withWriteLock(() => {
		const snapshots = files.map((f) => ({ f, prev: fs.existsSync(f) ? fs.readFileSync(f) : null }));
		const restore = () => {
			for (const { f, prev } of snapshots) {
				if (prev === null) fs.rmSync(f, { force: true });
				else fs.writeFileSync(f, prev);
			}
		};
		mutate();
		if (!commentsMayDecrease) {
			try {
				assertCommentsKept(ws, snapshots);
			} catch (e) {
				restore();
				throw e;
			}
		}
		try {
			compile(ws); // dry-run that doubles as the materialization — throws CompileError on bad sources
		} catch (e) {
			restore();
			try { compile(ws); } catch { /* runtime was already broken before this op */ }
			// ⚠ THE ROLLBACK IS THE HALF THE OPERATOR CANNOT SEE. compile's sentence is correct and
			// names the missing declaration; what it cannot know is that a verb just undid itself over
			// it. The commonest case by far is an overlay write into a module that does not yet declare
			// its base, so the remedy is spelled as the verb that fixes it — §13. The module names in
			// compile's sentence are PACKAGE names while `dt set modules/<id>` takes an ID; for anything
			// `add modules` created they are the same string, for a forked module they are not.
			const dep = /module "([^"]+)" does not declare "([^"]+)" in dreamteamer\.dependencies/.exec(e.message);
			if (dep) {
				const idOf = (pkgName) => moduleRows(store).find((r) => r.fields.name === pkgName)?.id ?? pkgName;
				throw new Error(`${e.message}\n  rolled back — dt set modules/${idOf(dep[1])} dependencies=modules/${idOf(dep[2])}, then re-run`);
			}
			throw e;
		}
		// ⚠ AFTER THE GATE COMPILE, BEFORE THE COMMIT, INSIDE THE LOCK. A schema op that INVALIDATES
		// DATA cleans that data up in the same act — see dropOrphanedMirrors for the case this exists
		// for. It has to run after the compile because it reads the NEW runtime to decide what is
		// residue, and before the commit because a source change and the data repair it forces are one
		// change. It fails the whole op like anything else here: nothing half-done.
		let extra = { files: [], undo: () => {}, dropped: [], cleared: 0 };
		if (after) {
			try {
				extra = { ...extra, ...after() };
			} catch (e) {
				restore();
				try { compile(ws); } catch { /* nothing else moved */ }
				throw e;
			}
		}
		const rels = [...files, ...extra.files].map((f) => path.relative(ws.root, f));
		// Schema ops commit UNCONDITIONALLY — `auto-commit` governs RECORD writes only. A source
		// change is inseparable from the compile that validated it, and `dt commit` scopes itself
		// to record directories, so a deferred source edit would be publishable by nothing.
		// Extending `dt commit` to module sources is the natural follow-on; it is not this wave.
		//
		// ⚠ IN THE REPO THAT HOLDS THE SOURCE, not at the workspace root — see commitByRepo for what
		// running it at the root cost a git-shape module.
		let commits;
		try {
			commits = commitByRepo(ws, store, rels, subject);
		} catch (e) {
			extra.undo();
			restore();
			try { compile(ws); } catch { /* pre-op sources were compilable */ }
			const landed = (e.commits ?? []).length
				? ` (${e.commits.map((c) => `${c.repo} already committed as ${c.sha}`).join('; ')} — that commit stands; two repos cannot commit atomically)`
				: '';
			throw new Error(`git commit failed — the schema change was rolled back, nothing was changed.${landed} (${e.message.split('\n')[0]})`);
		}
		// The hook's own report, for the caller to print: what a source change did to DATA is not
		// visible in the file list, and a silent data change is a different act from a reported one.
		return { ...extra, commits };
	});
}

/** The compile half of the gate, under the same lock, with no source write and no commit — for a
 *  schema op that turns out to ask for what is already on disk. Materializing `.dreamteamer/` is the
 *  point rather than a side effect: the caller is about to report success, and success has always
 *  meant "the compiled runtime is valid and current". */
function compileGated(ws, store) {
	return store.withWriteLock(() => compile(ws));
}

/**
 * THE GATE FOR AN OP WHOSE MUTATION IS NOT A SET OF FILE WRITES — a folder move, a delete, several
 * package.json edits at once.
 *
 * `writeGated` snapshots BYTES per file, which cannot express any of those: a directory hands
 * `readFileSync` an EISDIR, and a pathspec naming only one file inside a deleted tree commits one
 * deletion and leaves the rest staged-but-uncommitted. So the caller supplies its own `undo` and
 * this owns the ORDER, which is the part that must not be re-derived per op: mutate → compile →
 * commit, and on any failure undo, recompile, rethrow.
 *
 * Same cross-process write lock, same "nothing half-done" contract, same `headMoved()` after a
 * commit. `renameCollection` is the precedent — it has carried its own copy of this block since it
 * needed to move a record folder, and this is that block with the mutation lifted out.
 *
 * `mutate()` may return `{ paths }` to extend the commit pathspec with files it discovered; its
 * return value is what this returns.
 */
export function gatedTreeOp(ws, store, { subject, paths, mutate, undo }) {
	return store.withWriteLock(() => {
		let out;
		try {
			out = mutate() ?? {};
			compile(ws); // the gate: an uncompilable change never reaches history
		} catch (e) {
			undo();
			try { compile(ws); } catch { /* pre-op sources were compilable */ }
			throw e;
		}
		// ⚠ NO PATHSPEC FILTER HERE ANY MORE. `commitByRepo` does it per repo, which is the correct
		// place: `isTracked` has to run in the repo that would track the path, and running it at the
		// workspace root answered "no" for every path inside a clone.
		const rels = [...new Set([...paths, ...(out.paths ?? [])])];
		try {
			out.commits = commitByRepo(ws, store, rels, subject);
		} catch (e) {
			undo();
			try { compile(ws); } catch { /* pre-op sources were compilable */ }
			const landed = (e.commits ?? []).length
				? ` (${e.commits.map((c) => `${c.repo} already committed as ${c.sha}`).join('; ')} — that commit stands)`
				: '';
			throw new Error(`git commit failed — ${subject} was rolled back, nothing was changed.${landed} (${e.message.split('\n')[0]})`);
		}
		return out;
	});
}

// ---- modules ---------------------------------------------------------------------------------
// A module is THREE-SPELLED today: the package `name` (discovery, `extends:`, `dependencies`), the
// folder (the `workspace-module` key), and the slugged scope-stripped record id. The RECORD ID is
// the identity everywhere the operator types it — `--module <id>`, `modules/<id>` references,
// `dependencies` values — and the engine maps id → package name internally. `add modules` sets all
// three to one string so a new module never forks; an existing forked module keeps working, and
// `dt list modules` prints all three columns so the fork is visible.

/** A module id: the same id-safe alphabet a namespace segment uses, because it becomes a folder
 *  name, a package name and a record id at once. */
const MODULE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Every module as `{ id, fields }`, off the compiled projection — the one enumeration, so `--module`
 *  validation, the "known:" list and the id→package-name map cannot disagree. */
function moduleRows(store) {
	if (!store.descriptors.has('modules')) return [];
	return [...store.readAll('modules')].map((r) => ({ id: r.id, fields: r.fields }));
}

/** One module, or the refusal §13 requires: `no module "nope" — known: core, hr, default (dt list
 *  modules). A module is named by its id.` */
export function moduleRecord(store, id) {
	const rows = moduleRows(store);
	const hit = rows.find((r) => r.id === id);
	if (hit) return hit;
	throw new Error(`no module "${id}" — known: ${rows.map((r) => r.id).join(', ') || 'none'} (dt list modules). A module is named by its id.`);
}

/** id → the package `name` its sources actually spell, which is what `extends`, `dependencies` and
 *  `disable` are written in. Equal to the id for anything `add modules` created. */
const packageNameOf = (store, id) => moduleRecord(store, id).fields.name;

/** A module's own package.json, absolute. */
function modulePkgFile(ws, store, id) {
	return path.join(ws.root, moduleRecord(store, id).fields.path, 'package.json');
}

/** Read → mutate the `dreamteamer` section → write, preserving every other key and the tab
 *  indentation `init` uses. Returns the file path so a caller can put it in a pathspec. */
function editModulePkg(file, mutate) {
	const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
	pkg.dreamteamer ??= {};
	mutate(pkg.dreamteamer, pkg);
	fs.writeFileSync(file, JSON.stringify(pkg, null, '\t') + '\n');
	return file;
}

/** The workspace's own package.json, read → mutate → write. `ws.pkg` is refreshed in place because
 *  `compile({root, pkg})` reads the object it was handed, not the file — a rename that moved
 *  `workspace-module` and did not do this compiled the PREVIOUS layout and failed on a stray-sources
 *  error naming a module that no longer exists. */
function editWorkspacePkg(ws, mutate) {
	const file = path.join(ws.root, 'package.json');
	const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
	pkg.dreamteamer ??= {};
	mutate(pkg.dreamteamer, pkg);
	fs.writeFileSync(file, JSON.stringify(pkg, null, '\t') + '\n');
	for (const k of Object.keys(ws.pkg)) delete ws.pkg[k];
	Object.assign(ws.pkg, pkg);
	return file;
}

export function createModule(ws, store, { name, description }) {
	if (!name || name === true) throw new Error('missing module name — dreamteamer add modules --name <id>');
	if (!MODULE_ID.test(name)) {
		throw new Error(`invalid module id "${name}" — lowercase alphanumeric with single hyphens. It becomes a folder name, a package name and a record id at once, so there is only one spelling.`);
	}
	const rows = moduleRows(store);
	const clash = rows.find((r) => r.id === name);
	if (clash) throw new Error(`module "${name}" already exists (${clash.fields.path}) — dt list modules`);
	const root = path.join(ws.root, 'modules', name);
	if (fs.existsSync(root)) throw new Error(`modules/${name} already exists on disk — remove it or pick another id`);

	const dt = {};
	if (typeof description === 'string' && description) dt.description = description;
	// `files` is the npm publish surface: every kind a module CAN ship, so a kind added to the engine
	// does not silently stop being packaged.
	const mpkg = { name, private: true, version: '0.0.1', files: [...KINDS], dreamteamer: dt };
	const pkgFile = path.join(root, 'package.json');

	const out = gatedTreeOp(ws, store, {
		subject: `dreamteamer: modules add ${name}`,
		paths: [path.relative(ws.root, pkgFile)],
		mutate: () => {
			// ⚠ SCAFFOLD EVERY KIND FOLDER. Not decoration: it is what makes the module's shape
			// self-documenting the moment it exists, and compile's "contributed no recognised sources"
			// warning is taught to read a scaffolded folder as a module being authored (see compile.js)
			// rather than as a mistake — a verb whose own output triggers a warning reads as broken.
			// git cannot track an empty directory, so only package.json is in the pathspec.
			for (const kind of KINDS) fs.mkdirSync(path.join(root, kind), { recursive: true });
			fs.writeFileSync(pkgFile, JSON.stringify(mpkg, null, '\t') + '\n');
		},
		undo: () => fs.rmSync(root, { recursive: true, force: true }),
	});
	return { id: name, root: path.relative(ws.root, root), file: pkgFile, commits: out.commits };
}

/** The settable fields of a `modules` record, and how each translates from the record-shaped value
 *  the operator types to the form the source file uses. */
const MODULE_SETTABLE = {
	description: { key: 'description', from: (v) => String(v) },
	dependencies: { key: 'dependencies', from: (v, store) => asList(v).map((r) => moduleIdFromRef(r, store)) },
	peerDependencies: { key: 'peerDependencies', from: (v) => asList(v).map((r) => String(r).replace(/^collections\//, '')) },
	// §8. A namespace is a plain name, not a reference — there is no `namespaces` collection and
	// there should not be: the value's whole job is to be parseable before anything has compiled.
	namespaces: { key: 'namespaces', from: (v) => asList(v).map((x) => x.replace(/^\/+|\/+$/g, '')).filter(Boolean) },
};

const asList = (v) => (Array.isArray(v) ? v : String(v).split(',')).map((s) => String(s).trim()).filter(Boolean);

/** `modules/core` → the package name `core` spells. A bare `core` is accepted and named as a
 *  mistake-in-waiting rather than silently: a reference VALUE is `<collection>/<id>` everywhere else
 *  in this engine, and `check` rejects the bare form. */
function moduleIdFromRef(ref, store) {
	const s = String(ref);
	if (!s.startsWith('modules/')) {
		throw new Error(`dependencies takes record-shaped values — write "modules/${s}", not "${s}" (a reference is <collection>/<id> everywhere in this engine).`);
	}
	return packageNameOf(store, s.slice('modules/'.length));
}

export function setModule(ws, store, id, changes) {
	const rec = moduleRecord(store, id);
	const unknown = Object.keys(changes).filter((k) => !(k in MODULE_SETTABLE));
	if (unknown.length) {
		throw new Error(`"${unknown[0]}" is not a settable field of modules — settable: ${Object.keys(MODULE_SETTABLE).join(', ')}. Everything else on a module record is PROJECTED by compile from its package.json.`);
	}
	const file = path.join(ws.root, rec.fields.path, 'package.json');
	if (IN_NODE_MODULES(rec.fields.path)) {
		throw new Error(`module "${id}" ships from node_modules (${rec.fields.path}) — a write there is erased by the next \`npm install\`. Vendor it into modules/ or install it as a git module.`);
	}
	const changed = [];
	// ⚠ THE WORKSPACE'S REDUNDANT COPY GOES IN THE SAME WRITE. Declaring a namespace on the module
	// is what makes the workspace-level entry redundant, and compile WARNS about it — so leaving it
	// behind makes the warning permanent and the fix a second command nobody is told to run.
	const wsFile = path.join(ws.root, 'package.json');
	const files = 'namespaces' in changes ? [file, wsFile] : [file];
	const gate = writeGated(ws, store, files, `dreamteamer: modules set ${id}`, () => {
		let declared = [];
		editModulePkg(file, (dt) => {
			for (const [k, raw] of Object.entries(changes)) {
				const spec = MODULE_SETTABLE[k];
				// An empty value REMOVES the key — the same convention `store.set` has always had for a
				// record field, extended to the package.json a module record is projected from.
				if (raw === '' || raw === null) { delete dt[spec.key]; changed.push(k); continue; }
				const value = spec.from(raw, store);
				if (Array.isArray(value) && !value.length) { delete dt[spec.key]; changed.push(k); continue; }
				dt[spec.key] = value;
				changed.push(k);
				if (k === 'namespaces') declared = value;
			}
		});
		if (declared.length) {
			editWorkspacePkg(ws, (dt) => {
				if (!Array.isArray(dt.namespaces)) return;
				dt.namespaces = dt.namespaces.filter((n) => !declared.includes(String(n).replace(/^\/+|\/+$/g, '')));
				if (!dt.namespaces.length) delete dt.namespaces;
			});
		}
	}, undefined, { commentsMayDecrease: true });
	return { id, file, changed, commits: gate.commits };
}

export function removeModule(ws, store, id, { force = false, dryRun = false } = {}) {
	const { fields } = moduleRecord(store, id);
	if (fields.channel === 'npm') {
		throw new Error(`module "${id}" is installed by npm (${fields.path}) — remove it from package.json dependencies and run \`npm install\`; a delete under node_modules/ is erased by the next install.`);
	}
	if (fields.channel === 'git') {
		throw new Error(`module "${id}" is a clone under ${fields.path}, and its package.json lives in ANOTHER repo — remove it from dreamteamer.git-modules and delete the clone. This verb removes inline modules only.`);
	}
	if (ws.pkg.dreamteamer?.['workspace-module'] === id) {
		throw new Error(`module "${id}" IS this workspace's own module (dreamteamer.workspace-module) — removing it would leave the workspace with no sources of its own. Point workspace-module at another module first.`);
	}
	if (fields.owns_data === true) {
		throw new Error(`module "${id}" sets owns-data, so its records live INSIDE ${fields.path}/data — removing the module would delete them, which this verb never does. Drop owns-data and move the records out first.`);
	}

	const shipped = (fields.collections ?? []).map((r) => String(r).replace(/^collections\//, '')).sort();
	const withRecords = shipped.filter((c) => store.descriptors.has(c) && store.ids(c).size > 0);
	if (shipped.length && !force) {
		throw new Error(`${id} still ships ${shipped.length} collection${shipped.length === 1 ? '' : 's'} (${shipped.join(', ')}), ${withRecords.length} with records. --force removes the sources; records stay and become unindexed.`);
	}
	// A `dependencies` entry naming this module in ANOTHER module fails the gate compile ("depends
	// on X, which is not installed"), so it goes in the SAME write — otherwise --force is a verb that
	// cannot succeed. peerDependencies names COLLECTIONS and needs no edit: a peer whose provider is
	// gone is exactly what `unresolved_peers` exists to excuse.
	const pkgName = fields.name;
	const dependents = moduleRows(store)
		.filter((r) => r.id !== id && (r.fields.dependencies ?? []).includes(`modules/${id}`))
		.map((r) => r.id);
	const plan = {
		collections: shipped, withRecords, dependents,
		records: 0, refs: 0, descriptors: shipped.length,
		cleared: 0,
	};
	if (dryRun) return { ...plan, dryRun: true };

	const root = path.join(ws.root, 'modules', id);
	// ⚠ STASH, DO NOT DELETE, UNTIL THE COMMIT LANDS. `gatedTreeOp`'s `undo` has to be able to put the
	// whole tree back, and a `rmSync` cannot be undone. `.dreamteamer/` is gitignored and on the same
	// device (a cross-device rename would fail), and compile only ever removes the kind folders and
	// `system/`/`ui/` by name — a dot-prefixed sibling survives it.
	const stash = path.join(ws.root, '.dreamteamer', `.rm-module-${id}`);
	const depFiles = dependents.map((m) => modulePkgFile(ws, store, m));
	const depBytes = new Map(depFiles.map((f) => [f, fs.readFileSync(f)]));
	fs.rmSync(stash, { recursive: true, force: true });

	let out;
	try {
		out = gatedTreeOp(ws, store, {
			subject: `dreamteamer: modules rm ${id}`,
			paths: [path.relative(ws.root, root), ...depFiles.map((f) => path.relative(ws.root, f))],
			mutate: () => {
				for (const f of depFiles) {
					editModulePkg(f, (dt) => {
						dt.dependencies = (dt.dependencies ?? []).filter((n) => n !== pkgName);
						if (!dt.dependencies.length) delete dt.dependencies;
					});
				}
				fs.mkdirSync(path.dirname(stash), { recursive: true });
				fs.renameSync(root, stash);
			},
			undo: () => {
				if (fs.existsSync(stash)) fs.renameSync(stash, root);
				for (const [f, bytes] of depBytes) fs.writeFileSync(f, bytes);
			},
		});
	} finally {
		fs.rmSync(stash, { recursive: true, force: true });
	}
	return { removed: id, ...plan, commits: out.commits };
}

export function renameModule(ws, store, oldId, newId) {
	if (!newId || newId === true) throw new Error('missing new module id — dreamteamer rename modules/<old> <new>');
	if (oldId === newId) return { renamed: false, id: newId, files: [], rewrites: 0 };
	if (!MODULE_ID.test(newId)) throw new Error(`invalid module id "${newId}" — lowercase alphanumeric with single hyphens.`);
	const { fields } = moduleRecord(store, oldId);
	if (moduleRows(store).some((r) => r.id === newId)) throw new Error(`module "${newId}" already exists — dt list modules`);
	if (fields.channel === 'npm') {
		throw new Error(`module "${oldId}" ships from node_modules (${fields.path}) — a write there is erased by the next \`npm install\`. Rename it in its own repo and release.`);
	}
	if (fields.channel === 'git') {
		// ⚠ TWO COMMITS BY CONSTRUCTION, and the verb says so rather than half-doing it: the module's
		// package.json lives in the clone's own repo, and this workspace's half (git-modules, extends,
		// dependencies, modules/<id> refs) is a commit here. Perform the workspace half only after the
		// clone half has landed and been pushed.
		throw new Error(`module "${oldId}" is a clone under ${fields.path}, whose package.json is in ANOTHER repo — a git-shape rename is TWO commits by construction.\n  1. rename it there (package.json name → "${newId}") and push;\n  2. re-run this to perform the workspace half: dreamteamer.git-modules, every extends:, every dependencies entry, and modules/${oldId} references.`);
	}
	const oldPkgName = fields.name;
	const oldRoot = path.join(ws.root, 'modules', oldId);
	const newRoot = path.join(ws.root, 'modules', newId);
	if (fs.existsSync(newRoot)) throw new Error(`modules/${newId} already exists on disk`);

	const snapshots = new Map(); // absolute file -> bytes, for undo
	const snap = (f) => { if (!snapshots.has(f) && fs.existsSync(f)) snapshots.set(f, fs.readFileSync(f)); return f; };
	const paths = new Set([`modules/${oldId}`, `modules/${newId}`, 'package.json']);
	let moved = false;
	let rewrites = 0;
	const undoRefs = [];

	const out = gatedTreeOp(ws, store, {
		subject: `dreamteamer: modules rename ${oldId} → ${newId}`,
		paths: [...paths],
		mutate: () => {
			// 1. the module's own record refs, BEFORE the folder moves — `store.rewriteRefsBatch`
			//    resolves each collection's directory from the descriptors the Store was built with,
			//    and those are still correct until compile re-runs.
			const refs = store.rewriteRefs(`modules/${oldId}`, `modules/${newId}`);
			undoRefs.push(refs.restore);
			rewrites += refs.rewrites;
			for (const f of refs.touched) paths.add(path.relative(ws.root, f));

			// 2. the folder, then its package.json `name`
			fs.renameSync(oldRoot, newRoot);
			moved = true;
			const ownPkg = path.join(newRoot, 'package.json');
			const ownBytes = fs.readFileSync(ownPkg);
			snapshots.set(path.join(oldRoot, 'package.json'), ownBytes); // restored after the un-move
			const own = JSON.parse(ownBytes.toString('utf8'));
			own.name = newId;
			fs.writeFileSync(ownPkg, JSON.stringify(own, null, '\t') + '\n');

			// 3. the WORKSPACE package.json: `workspace-module` when it names this module, and every
			//    `disable` entry prefixed with the old package name. SNAPSHOTTED FIRST — editWorkspacePkg
			//    writes, so capturing the pre-image afterwards is impossible.
			snap(path.join(ws.root, 'package.json'));
			const wsFile = editWorkspacePkg(ws, (dt) => {
				if (dt['workspace-module'] === oldId) dt['workspace-module'] = newId;
				if (Array.isArray(dt.disable)) {
					dt.disable = dt.disable.map((e) => (String(e).startsWith(`${oldPkgName}/`) ? `${newId}/${String(e).slice(oldPkgName.length + 1)}` : e));
				}
			});
			paths.add(path.relative(ws.root, wsFile));

			// 4. every OTHER module's `dreamteamer.dependencies` naming it. peerDependencies names
			//    collections and is untouched.
			for (const r of moduleRows(store)) {
				if (r.id === oldId || r.fields.channel === 'npm') continue;
				const f = path.join(ws.root, r.fields.path, 'package.json');
				if (!fs.existsSync(f)) continue;
				const dt = JSON.parse(fs.readFileSync(f, 'utf8')).dreamteamer ?? {};
				if (!(dt.dependencies ?? []).includes(oldPkgName)) continue;
				snap(f);
				editModulePkg(f, (d) => { d.dependencies = d.dependencies.map((n) => (n === oldPkgName ? newId : n)); });
				paths.add(path.relative(ws.root, f));
				rewrites++;
			}

			// 5. every `extends: <oldPkgName>/<collection>` in a descriptor source — ROUND-TRIPPED, for
			//    the reason renameCollection round-trips: a descriptor's comments are where a module
			//    writes down why the collection exists, and `dump` cannot keep them.
			for (const f of descriptorSources(ws, store)) {
				const before = fs.readFileSync(f, 'utf8');
				const doc = load(before);
				const ext = doc?.extends;
				if (typeof ext !== 'string' || !ext.startsWith(`${oldPkgName}/`)) continue;
				doc.extends = `${newId}/${ext.slice(oldPkgName.length + 1)}`;
				const after = writeSource(before, doc);
				if (load(after)?.extends !== doc.extends || commentCount(after) < commentCount(before)) {
					throw new Error(`could not rewrite \`extends\` in ${path.relative(ws.root, f)} without reformatting it — nothing was changed.`);
				}
				snap(f);
				fs.writeFileSync(f, after);
				paths.add(path.relative(ws.root, f));
				rewrites++;
			}
			return { paths: [...paths] };
		},
		undo: () => {
			for (const u of [...undoRefs].reverse()) u();
			if (moved && fs.existsSync(newRoot)) fs.renameSync(newRoot, oldRoot);
			for (const [f, bytes] of snapshots) {
				fs.mkdirSync(path.dirname(f), { recursive: true });
				fs.writeFileSync(f, bytes);
			}
			// re-read the workspace package.json into ws.pkg, whatever it now says on disk
			editWorkspacePkg(ws, () => {});
		},
	});
	return { renamed: true, id: newId, files: out.paths ?? [], rewrites, commits: out.commits };
}

// ---- moving a collection between modules -------------------------------------------------------
// §7. `dt set collections/teams module=hr` — NOT `move`, which is nav ordering. The descriptor
// SOURCE relocates; the RECORDS do not, because a namespace and a `storage.path` are properties of
// the collection rather than of the module, so a move never changes an id and never touches data.

/**
 * WHAT THE MOVE WOULD MAKE ILLEGAL, and what the fix would cost — computed BEFORE anything moves.
 *
 * The reference contract (2026-08-11, part 1) says every target of an `x-reference` is owned by the
 * referencing module, declared in its `dependencies`, or named in its `peerDependencies`. Moving a
 * collection changes who owns it, so it can break the contract in two directions at once: this
 * collection's own outbound refs, and every inbound ref pointing at it.
 *
 * ⚠ AND THE FIX CAN BE WORSE THAN THE BREAK. `dependencies` must be acyclic, so "add A to B's
 * dependencies" is only a fix when B does not already sit upstream of A — otherwise it is a ring,
 * and the honest answer is `peerDependencies` (which names a COLLECTION and therefore cannot cycle)
 * or moving the other collection too. Naming the ring is the difference between a refusal an
 * operator can act on and one they have to re-derive.
 *
 * Reads the compiled projections through the Store rather than re-running discovery: `modules`
 * records carry `dependencies`, `collections` records carry `module`, and the manifest is what
 * actually compiled.
 */
function moveImpact(store, name, toModule) {
	const mods = moduleRows(store);
	const depsOf = new Map(mods.map((m) => [m.id, (m.fields.dependencies ?? []).map((r) => String(r).replace(/^modules\//, ''))]));
	// ⚠ `peer_dependencies`, SNAKE-CASED — that is the key compile projects onto the module record
	// (`peerDependencies` is the package.json spelling). Reading the camel form here returned
	// undefined for every module and silently switched the peer escape hatch off, so a move a
	// declared peer legitimately permits would have been refused with the ring message.
	const peersOf = new Map(mods.map((m) => [m.id, (m.fields.peer_dependencies ?? []).map((r) => String(r).replace(/^collections\//, ''))]));
	const ownerOf = new Map();
	for (const { id, fields } of store.readAll('collections')) ownerOf.set(id, fields.module ?? String(fields.owner ?? '').replace(/^modules\//, ''));
	ownerOf.set(name, toModule); // the world as the move would leave it

	/** Does `from` reach `to` along `dependencies`? */
	const reaches = (from, to, seen = new Set()) => {
		if (from === to) return true;
		if (seen.has(from)) return false;
		seen.add(from);
		return (depsOf.get(from) ?? []).some((d) => reaches(d, to, seen));
	};

	const needs = [];
	const add = (referrer, target) => {
		const owner = ownerOf.get(target);
		if (!owner || owner === referrer) return;
		if ((depsOf.get(referrer) ?? []).includes(owner)) return;
		if ((peersOf.get(referrer) ?? []).includes(target)) return;
		// CORE_COLLECTIONS is an implicit dependency of every module — the entity kinds the compiler
		// materializes plus `repos`. Asked of the descriptor rather than of a list here: a
		// runtime-stored collection is exactly that set.
		if (store.descriptors.get(target)?.storage?.base === 'runtime' || target === 'repos') return;
		needs.push({ referrer, target, owner, ring: reaches(owner, referrer) });
	};

	for (const [cName, d] of store.descriptors) {
		const referrer = ownerOf.get(cName);
		if (!referrer) continue;
		for (const target of outboundTargets(d)) {
			if (cName !== name && target !== name) continue; // only edges this move actually re-owns
			add(referrer, target);
		}
	}
	return needs;
}

/** Every collection an `x-reference` in this descriptor points at — scalar, union list, on the prop
 *  or on `items`. `refTargetsOf` answers per prop; this walks the schema. `'*'` is skipped: the
 *  wildcard is rule 6's, and rule 6 is the workspace module's only exemption. */
function outboundTargets(d) {
	const out = new Set();
	const walkProps = (schema) => {
		for (const prop of Object.values(schema?.properties ?? {})) {
			if (!prop || typeof prop !== 'object') continue;
			for (const holder of [prop, prop.items]) {
				const raw = holder && typeof holder === 'object' ? holder['x-reference'] : undefined;
				if (raw === undefined || raw === '*') continue;
				for (const t of [].concat(raw)) if (typeof t === 'string' && t !== '*') out.add(t);
			}
			if (prop.properties) walkProps(prop);
			if (prop.items?.properties) walkProps(prop.items);
		}
	};
	walkProps(d.schema);
	return out;
}

export function moveCollection(ws, store, name, toModule, { dryRun = false } = {}) {
	const d = store.descriptor(name); // throws with the known-collection list
	if (d.storage.base === 'runtime') {
		throw new Error(`"${name}" is a compiled source, not a data collection — it has no module to move it to.`);
	}
	const to = moduleRecord(store, toModule); // throws with the known-module list
	const from = d.module ?? String(d.owner ?? '').replace(/^modules\//, '');
	if (from === toModule) return { moved: false, name, from, to: toModule };
	if (IN_NODE_MODULES(to.fields.path)) {
		throw new Error(`module "${toModule}" ships from node_modules (${to.fields.path}) — a write there is erased by the next \`npm install\`. Vendor it into modules/ first.`);
	}
	const { base, overlays } = baseDescriptorSource(ws, name);
	if (!base) throw new Error(`"${name}" has no writable descriptor source in this workspace — the manifest names none under a module here.`);
	if (IN_NODE_MODULES(base)) {
		throw new Error(`"${name}" ships from node_modules (${base}) — a write there is erased by the next \`npm install\`. Overlay it with \`extends\` instead: dreamteamer add-field ${name} --module <your-module> …`);
	}

	// ---- the reference contract, BEFORE anything moves ------------------------------------------
	const needs = moveImpact(store, name, toModule);
	const plan = {
		name, from, to: toModule, needs,
		records: store.ids(name).size,
		refs: 0,
		descriptors: 1 + overlays.length,
		cleared: 0,
	};
	if (needs.length) {
		const lines = needs.map((n) => {
			const fix = n.ring
				? `${n.referrer} → ${n.owner} would be a ring (${n.owner} already reaches ${n.referrer}). Add ${n.target} to ${n.referrer}'s peerDependencies (dt set modules/${n.referrer} peerDependencies=collections/${n.target}), or move ${n.target} as well.`
				: `add it: dt set modules/${n.referrer} dependencies=modules/${n.owner} — or dt set modules/${n.referrer} peerDependencies=collections/${n.target} if ${n.referrer} should work without it.`;
			return `  ${n.referrer} references ${n.target}, owned by ${n.owner} after the move. ${fix}`;
		});
		throw new Error(`move rolled back. ${name} → ${toModule} breaks the reference contract:\n${lines.join('\n')}`);
	}
	if (dryRun) return { ...plan, moved: false, dryRun: true };

	const dest = path.join(kindDir(path.join(ws.root, to.fields.path), 'collections'), `${name}.collection.yaml`);
	if (fs.existsSync(dest)) throw new Error(`${path.relative(ws.root, dest)} already exists — move or remove it first; nothing was moved`);
	const src = path.join(ws.root, base);
	const fromRow = moduleRows(store).find((m) => m.id === from);
	const fromPkgName = fromRow?.fields.name ?? from;
	const toPkgName = to.fields.name;
	// The floor `pruneEmpty` walks up to: the SOURCE MODULE'S OWN collections dir. Deriving it from
	// the path's first segment resolved to `<root>/modules`, which could delete the module's whole
	// `collections/` folder after its last collection left — re-triggering the "contributed no
	// recognised sources" warning for a module whose only kind folder that was.
	const pruneFloor = fromRow ? kindDir(path.join(ws.root, fromRow.fields.path), 'collections') : path.dirname(src);

	const snapshots = new Map([[src, fs.readFileSync(src)]]);
	const touched = new Set([base, path.relative(ws.root, dest)]);
	let moved = false;

	const out = gatedTreeOp(ws, store, {
		subject: `dreamteamer: collections set ${name} module=${toModule}`,
		paths: [...touched],
		mutate: () => {
			// 1. the descriptor itself. Its BYTES, not a re-dump: a descriptor's comments are where a
			//    module writes down why the collection exists, and the move changes no key at all — the
			//    file is identical, at a new path.
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			fs.writeFileSync(dest, snapshots.get(src));
			fs.rmSync(src);
			pruneEmpty(path.dirname(src), pruneFloor);
			moved = true;

			// 2. every overlay's `extends`, which names the base by its OLD module's package name.
			for (const rel of overlays) {
				const f = path.join(ws.root, rel);
				const before = fs.readFileSync(f, 'utf8');
				const doc = load(before);
				if (doc?.extends !== `${fromPkgName}/${name}`) continue;
				doc.extends = `${toPkgName}/${name}`;
				const after = writeSource(before, doc);
				if (load(after)?.extends !== doc.extends || commentCount(after) < commentCount(before)) {
					throw new Error(`could not rewrite \`extends\` in ${rel} without reformatting it — nothing was changed.`);
				}
				snapshots.set(f, Buffer.from(before));
				fs.writeFileSync(f, after);
				touched.add(rel);
			}
			return { paths: [...touched] };
		},
		undo: () => {
			if (moved && fs.existsSync(dest)) fs.rmSync(dest);
			for (const [f, bytes] of snapshots) {
				fs.mkdirSync(path.dirname(f), { recursive: true });
				fs.writeFileSync(f, bytes);
			}
		},
	});
	return { ...plan, moved: true, commits: out.commits };
}

/**
 * The collection-level scalars, and how each parses. §11's papercut, and the other half of §7: with
 * `order` settable, `dt move collections/<c> --after <c>` can mean nav ordering and nothing else.
 *
 * ⚠ `name` is deliberately absent, and so is `extends`, `schema` and `storage`. Renaming a
 * collection moves its descriptor, its records, their filenames and every inbound reference in one
 * commit — that is `rename collections/<old> <new>`, and offering `name=` here would be a second
 * spelling for it that does one of those five things.
 */
const COLLECTION_SETTABLE = {
	description: (v) => String(v),
	use_when: (v) => String(v),
	title: (v) => String(v),
	title_template: (v) => String(v),
	icon: (v) => String(v),
	group: (v) => String(v),
	sort_field: (v) => String(v),
	order: (v) => {
		const n = Number(v);
		if (!Number.isFinite(n)) throw new Error(`order takes a number — got "${v}"`);
		return n;
	},
	list_fields: (v) => (Array.isArray(v) ? v : String(v).split(',')).map((s) => String(s).trim()).filter(Boolean),
};

/** "people has no field X" / "people has no fields X, Y" — the plural without a second sentence. */
const collectionMissingFields = (name, missing) => `${name} has no field${missing.length === 1 ? '' : 's'} ${missing.join(', ')}`;

export function setCollectionScalars(ws, store, name, changes, { moduleId } = {}) {
	store.descriptor(name);
	const unknown = Object.keys(changes).filter((k) => !(k in COLLECTION_SETTABLE));
	if (unknown.length) {
		const k = unknown[0];
		const extra = k === 'name' ? ` — a collection is renamed with its records and every inbound reference in one commit: dreamteamer rename collections/${name} <new-name>` : '';
		throw new Error(`"${k}" is not a settable scalar of a collection${extra}. Settable: ${Object.keys(COLLECTION_SETTABLE).join(', ')}, plus module= (which MOVES it). A field of the record schema is written with dreamteamer add-field/update-field ${name}.`);
	}
	// `list_fields` and `sort_field` name fields of THIS collection's OWN schema. A dangling
	// `sort_field` is already a compile error; a dangling `list_fields` entry compiles CLEAN and puts
	// a dead column in every default listing, which is why it is caught here.
	for (const key of ['list_fields', 'sort_field']) {
		if (!(key in changes)) continue;
		if (changes[key] === '' || changes[key] === null) continue; // a clear has nothing to validate
		const named = key === 'sort_field' ? [String(changes[key])] : COLLECTION_SETTABLE.list_fields(changes[key]);
		const missing = named.filter((f) => f && !store.descriptor(name).schema?.properties?.[f]);
		if (missing.length) {
			throw new Error(`${key}: ${collectionMissingFields(name, missing)} — declare it first (dreamteamer add-field ${name} --name ${missing[0]} --type <t>).`);
		}
	}
	const { file } = collectionSourceFile(ws, store, name, moduleId, { subject: name });
	if (!fs.existsSync(file)) throw new Error(`${path.relative(ws.root, file)} is not on disk — run \`dreamteamer compile\` and re-run.`);
	const previousText = fs.readFileSync(file, 'utf8');
	const doc = load(previousText);
	const changed = [];
	const gate = writeGated(ws, store, [file], `dreamteamer: collections set ${name} ${Object.keys(changes).join(' ')}`, () => {
		for (const [k, raw] of Object.entries(changes)) {
			// An empty value REMOVES the key — `store.set`'s convention, and `assignPath`'s, extended
			// to the descriptor a collection record is projected from.
			if (raw === '' || raw === null) delete doc[k];
			else doc[k] = COLLECTION_SETTABLE[k](raw);
			changed.push(k);
		}
		fs.writeFileSync(file, writeSource(previousText, doc));
	});
	return { name, file, changed, commits: gate.commits };
}

/** What `remove-field` would do, counted without writing — §7's rule that every verb clearing values
 *  prints its plan. The counts come from the same two sweeps the real op runs (`clearFieldValues`
 *  and `dropOrphanedMirrors`), asked in read-only form. */
export function removeFieldPlan(store, collection, fieldName) {
	const d = store.descriptor(collection);
	if (!d.schema?.properties?.[fieldName]) throw new Error(`no field "${fieldName}" on ${collection}`);
	const bf = bodyField(d);
	let cleared = 0;
	if (store.canRewrite(collection)) {
		for (const [, file] of store.ids(collection)) {
			let fields;
			try { fields = parseRecord(file, d, bf); } catch { continue; }
			if (fieldName in fields) cleared++;
		}
	}
	const mirrors = relationsOwnedBy(store, collection, fieldName);
	let records = cleared;
	for (const r of mirrors) if (store.canRewrite(r.target)) records += store.ids(r.target).size;
	return {
		collection, field: fieldName,
		records, refs: 0, descriptors: 1, cleared,
		staleViews: viewsNamingField(store, collection, fieldName),
	};
}

/** The workspace's writable source dir for a kind (workspace-module aware). `kindDir` picks the
 *  layout that module already uses and falls back to flat, so a `collections add` never splits a
 *  half-moved module across both. */
export function workspaceSystemDir(ws, kind) {
	const wm = ws.pkg.dreamteamer?.['workspace-module'];
	return kindDir(wm ? path.join(ws.root, 'modules', wm) : ws.root, kind);
}

/**
 * WHERE A COLLECTION'S DESCRIPTOR ACTUALLY LIVES — asked of the manifest, not assumed.
 *
 * `renameCollection` used to derive this from `workspaceSystemDir`, which silently meant "only the
 * workspace module's own collections can be renamed". That is the wrong line. The guard exists to
 * stop a write that will be ERASED, and the thing that erases writes is `npm install` — so the test
 * is `node_modules/`, not "which module". A module whose sources are inline in the workspace repo is
 * under the same git history as everything else and is perfectly safe to rewrite; refusing it made
 * `collections rename` unusable for exactly the migration it was built for, because a workspace's
 * domain collections almost always live in a module.
 *
 * Returns `{ dir, sources }` — the kind dir to write into (the SAME module the descriptor came from,
 * so a rename never teleports a collection into the workspace module), and every descriptor source
 * that contributed, so the caller can refuse the cases this cannot honestly do.
 */
function descriptorSourceDir(ws, name) {
	const entry = readManifest(ws.root)?.entries?.[`collections/${name}.collection.yaml`];
	// `sources` mixes the descriptor with any collection-templates it merged, so match on the shape
	// of a descriptor path for THIS collection. A namespaced name is nested, hence the full suffix.
	const suffix = `collections/${name}.collection.yaml`;
	const sources = (entry?.sources ?? [])
		.map((s) => s.path)
		.filter((p) => p.endsWith(suffix));
	if (!sources.length) return { dir: null, sources };
	// The BASE descriptor is the one to move. With an overlay present there are two, and the overlay's
	// `extends` names the base by its old qualified id — rewriting that is a second, different
	// migration, so the caller refuses rather than half-doing it.
	const moduleRoot = path.join(ws.root, sources[0].slice(0, sources[0].length - suffix.length));
	return { dir: kindDir(moduleRoot, 'collections'), sources };
}

/**
 * THE BASE DESCRIPTOR SOURCE, and the overlays beside it — asked of the manifest, decided by parsing.
 *
 * `descriptorSourceDir` above assumes `sources[0]` is the base, which is true in discovery order and
 * is not a fact anything checks. Every EDIT verb needs the base specifically — the rule is that
 * `set`, `rm`, `rename` and the field verbs act on the module that owns the entity and never teleport
 * it into the workspace module — so the base is identified the only way it is actually defined: it is
 * the contributing source that declares no `extends`.
 *
 * Returns workspace-relative paths. `base` is null when nothing in this workspace declares it (the
 * engine's own nine collections reach here that way), which is the signal to write an overlay.
 */
export function baseDescriptorSource(ws, name) {
	const suffix = `collections/${name}.collection.yaml`;
	const sources = (readManifest(ws.root)?.entries?.[suffix]?.sources ?? [])
		// sources are `{path, hash}`; tolerate the pre-0.10 string form, as compile's staleness does
		.map((s) => (typeof s === 'string' ? s : s?.path))
		.filter((p) => typeof p === 'string' && p.endsWith(suffix));
	let base = null;
	const overlays = [];
	for (const rel of sources) {
		const file = path.join(ws.root, rel);
		if (!fs.existsSync(file)) continue;
		let doc;
		try { doc = load(fs.readFileSync(file, 'utf8')); } catch { continue; }
		if (doc?.extends) overlays.push(rel);
		else base ??= rel;
	}
	return { base, overlays, sources };
}

/** A path git will not let us rewrite usefully: `npm install` erases it. Matched on the SEGMENT, in
 *  either separator, because manifest paths carry the host's. */
const IN_NODE_MODULES = (rel) => /(^|[\\/])node_modules([\\/]|$)/.test(String(rel));

/**
 * WHERE A FIELD VERB WRITES. The base descriptor's own file when this workspace may rewrite it; the
 * named module's overlay when a selector says so; the workspace module's overlay when neither.
 *
 * ⚠ The guard is `node_modules/`, NOT "which module" — that is the line `descriptorSourceDir`
 * already drew for `renameCollection` and the reason it drew it: the thing that erases a write is
 * `npm install`, and a module whose sources are inline in the workspace repo is under the same git
 * history as everything else. Resolving this from `workspaceSystemDir` instead meant a field verb on
 * ANY other inline module's collection silently created an overlay in the workspace module and then
 * failed compile for a dependency the operator never asked to declare.
 *
 * ⚠ `moduleId` IS A SELECTOR, NOT A DESTINATION. Naming the owner is redundant and naming a module
 * that contributes nothing is the DEFECT this wave exists to remove: `upsertField` used to create an
 * overlay wherever it was pointed, silently. So a selector that selects nothing is refused unless
 * the caller is deliberately creating an overlay, which `allowNew` says out loud.
 */
function collectionSourceFile(ws, store, collection, moduleId, { allowNew = false, subject } = {}) {
	const { base, overlays } = baseDescriptorSource(ws, collection);
	if (moduleId !== undefined && moduleId !== null && moduleId !== '') {
		const rec = moduleRecord(store, moduleId); // throws with the known-module list
		if (IN_NODE_MODULES(rec.fields.path)) {
			throw new Error(`module "${moduleId}" ships from node_modules (${rec.fields.path}) — a write there is erased by the next \`npm install\`.\n  to add fields from this workspace: dreamteamer add-field ${collection} --name <f> --module ${ws.pkg.dreamteamer?.['workspace-module'] ?? 'default'}`);
		}
		// ⚠ A SELECTOR SELECTS AMONG THINGS. `--module` is only meaningful where the entity is
		// declared by MORE than one module (a base plus overlays); anywhere else it is refused (§5),
		// naming who does declare it. `allowNew` is the one caller deliberately CREATING an overlay.
		const declared = declaringModules(ws, store, collection);
		if (!allowNew && declared.length < 2) {
			throw new Error(`${subject ?? collection} is declared only by ${declared.join(', ') || '?'} — drop --module`);
		}
		const own = [base, ...overlays].find((p) => p && String(p).startsWith(`${rec.fields.path}/`));
		if (own) return { file: path.join(ws.root, own), overlay: own !== base, module: moduleId };
		if (!allowNew) {
			throw new Error(`module "${moduleId}" contributes no source to ${collection} — it is declared by ${declared.join(', ') || 'nothing in this workspace'}. To ADD fields from ${moduleId}: dreamteamer add-field ${collection} --name <f> --module ${moduleId}`);
		}
		return { file: path.join(kindDir(path.join(ws.root, rec.fields.path), 'collections'), `${collection}.collection.yaml`), overlay: true, module: moduleId };
	}
	if (base && !IN_NODE_MODULES(base)) return { file: path.join(ws.root, base), overlay: false, module: null };
	return { file: path.join(workspaceSystemDir(ws, 'collections'), `${collection}.collection.yaml`), overlay: true, module: null };
}

/** The module ids whose sources declare this collection, base first — for the "declared only by X"
 *  refusal, which has to name them to be actionable. */
function declaringModules(ws, store, collection) {
	const { base, overlays } = baseDescriptorSource(ws, collection);
	const rows = moduleRows(store);
	const idOf = (rel) => rows.find((r) => String(rel).startsWith(`${r.fields.path}/`))?.id ?? '?';
	return [...new Set([base, ...overlays].filter(Boolean).map(idOf))];
}

/** The source file ONE module contributes to a collection — the read half of `--module`. Exported
 *  because `dt get collections/<c> --module <m>` is the only way to see what a given module actually
 *  wrote, and the merged descriptor cannot answer it. */
export function collectionSourceFileFor(ws, store, collection, moduleId) {
	return collectionSourceFile(ws, store, collection, moduleId);
}

// ---- ops ------------------------------------------------------------------------

export function createCollection(ws, store, { name, template, namespace, moduleId }) {
	if (!name) throw new Error('missing collection name');
	// §8. `--namespace health --name doctors` and `--name health/doctors` are the SAME collection,
	// because the qualified name IS the identity everywhere else in the engine — and a module that
	// declares exactly one namespace makes even that redundant. The resolved name is ALWAYS echoed,
	// because an inferred identity the operator did not type is one they must be able to read back.
	//
	// ⚠ THE COMPILED SET, not `ws.pkg.dreamteamer.namespaces`. Since §8 the declaration may live in
	// any module's package.json, and the union is resolved by compile and stamped into the manifest —
	// so a verb reading the workspace's own key alone would refuse a namespace a module declares.
	const declared = store.namespaces;
	const modNs = moduleId ? normalizeNamespaces(moduleRecord(store, moduleId).fields.namespaces) : [];
	let inferred = false;
	let ns0 = namespace;
	if (ns0 === undefined && modNs.length === 1 && !namespaceOf(name, [modNs[0]])) {
		ns0 = modNs[0];
		inferred = true;
	} else if (ns0 === undefined && modNs.length > 1 && !namespaceOf(name, modNs)) {
		throw new Error(`module ${moduleId} declares ${modNs.join(', ')} — say which: --namespace ${modNs[0]}`);
	}
	// `--namespace ''` is the explicit "no namespace", the same convention `dt set` has for clearing
	// a field. It arrives as the empty string and must not be confused with "not given".
	// ⚠ `qualify(ns, baseNameOf(name, [ns]))` is what stops the prefix DOUBLING: `--name hr/grades
	// --module hr` resolves the base name to `grades` and re-qualifies it once.
	const qualified = ns0 ? qualify(ns0, baseNameOf(name, [ns0])) : name;
	// The set INCLUDING a namespace this call is about to declare — `defaultStoragePath` and the
	// suffix derivation both split on it, and a name whose prefix is not yet in the set derives
	// `suffix: ops/plan` from `ops/plans`.
	const declaredAll = [...new Set([...declared, ...(ns0 ? [ns0] : [])])];
	const ns = namespaceOf(qualified, declaredAll);
	if (qualified.includes('/') && !ns) {
		throw new Error(`namespace "${qualified.slice(0, qualified.lastIndexOf('/'))}" is not declared — pass --namespace <ns> (which declares it where the collection will live), or declare it first: dt set modules/<m> namespaces=<ns>.`);
	}
	if (store.descriptors.has(qualified)) {
		// §13: name both remedies, because the operator asking for this wants ONE of them and the
		// generic "already exists" tells them which neither.
		const owner = store.descriptors.get(qualified).module
			?? String(store.descriptors.get(qualified).owner ?? '').replace(/^modules\//, '');
		const target = moduleId ?? ws.pkg.dreamteamer?.['workspace-module'] ?? 'default';
		throw new Error(`collection "${qualified}" already exists, owned by ${owner}. Fields from ${target}: dreamteamer add-field ${qualified} --module ${target} --name <f> --type <t> · move it: dreamteamer set collections/${qualified} module=${target}`);
	}
	// NESTED, mirroring where compile puts it in the runtime: `collections/health/doctors.collection.yaml`.
	// compile enumerates this kind recursively for exactly this reason — and `upsertField` derives the
	// same path from the same name, which is what keeps a later `add-field` editing the base descriptor
	// instead of quietly creating an overlay beside it.
	// …and in the module the caller NAMED — the workspace module only by default. `--module` is what
	// makes a module-first modeling session one verb per step instead of six manual ones.
	const intoRoot = moduleId ? path.join(ws.root, moduleRecord(store, moduleId).fields.path) : null;
	if (intoRoot && IN_NODE_MODULES(path.relative(ws.root, intoRoot))) {
		throw new Error(`module "${moduleId}" ships from node_modules — a write there is erased by the next \`npm install\`. Vendor it into modules/ first.`);
	}
	const dest = path.join(intoRoot ? kindDir(intoRoot, 'collections') : workspaceSystemDir(ws, 'collections'), `${qualified}.collection.yaml`);
	if (fs.existsSync(dest)) throw new Error(`${path.relative(ws.root, dest)} already exists`);

	let descriptor = { name: qualified };
	if (template) {
		const tplFile = path.join(runtimeKindDir(ws.root, 'collection-templates'), `${template}.collection-template.yaml`);
		if (!fs.existsSync(tplFile)) throw new Error(`unknown collection-template "${template}"`);
		descriptor = { name: qualified, ...structuredClone(load(fs.readFileSync(tplFile, 'utf8')).template) };
	} else {
		// templateless: MINIMAL but compilable — grow it with add-field
		descriptor.id = { generate: '{{ name | slug }}' };
		descriptor.schema = { type: 'object', required: ['name'], properties: { name: { type: 'string' } } };
	}
	descriptor.storage = {
		// AUTHORED even though compile would derive the same value, because a descriptor a human opens
		// should say where its records live without them having to know the derivation rule.
		path: defaultStoragePath(qualified, declaredAll, ws.pkg.dreamteamer?.['data-path'] ?? 'data'),
		codec: 'md', shape: 'file',
		...descriptor.storage,
		// the SUFFIX comes off the bare name — `health/doctors` records are `<id>.doctor.md`, not
		// `<id>.health/doctor.md`
		suffix: descriptor.storage?.suffix ?? singular(baseNameOf(qualified, declaredAll)),
	};
	// `--namespace x` where nobody declares `x` DECLARES it, in the module the collection is landing
	// in — else the workspace. Writing a source that cannot compile and then telling the operator to
	// go declare it is the shape §8 exists to remove; and the module is the right home, because that
	// is what travels when the module is copied (decision 130's gate).
	const needsDeclaration = !!ns && !declared.includes(ns);
	const declFile = needsDeclaration
		? (moduleId ? path.join(ws.root, moduleRecord(store, moduleId).fields.path, 'package.json') : path.join(ws.root, 'package.json'))
		: null;
	const gate = writeGated(ws, store, declFile ? [dest, declFile] : [dest], `dreamteamer: collections add ${qualified}`, () => {
		if (declFile && moduleId) {
			editModulePkg(declFile, (dt) => { dt.namespaces = normalizeNamespaces([...(dt.namespaces ?? []), ns]); });
		} else if (declFile) {
			editWorkspacePkg(ws, (dt) => { dt.namespaces = normalizeNamespaces([...(dt.namespaces ?? []), ns]); });
		}
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, dump(descriptor));
	}, undefined, { commentsMayDecrease: true });
	return {
		file: dest, descriptor, name: qualified, inferred,
		declaredNamespace: needsDeclaration ? ns : null,
		commits: gate.commits,
	};
}

export function removeCollection(ws, store, name, { force = false } = {}) {
	const d = store.descriptor(name);
	// The module that SHIPS it, not the workspace module. Refusing every module-shipped collection
	// made this verb unusable for exactly the workspace it was built for: a vault's domain
	// collections almost always live in a module.
	const { base, overlays } = baseDescriptorSource(ws, name);
	if (!base) {
		throw new Error(`"${name}" has no writable descriptor source — the manifest names none under a module in this workspace. It may be contributed by the engine itself; add "<module>/${name}" to dreamteamer.disable instead.`);
	}
	if (IN_NODE_MODULES(base)) {
		throw new Error(`"${name}" ships from node_modules (${base}) — a write there is erased by the next \`npm install\`. Add "<module>/${name}" to dreamteamer.disable instead.`);
	}
	// An `extends` descriptor with no base fails compile ("every descriptor declares 'extends' — no
	// base found"), so removing the base under a live overlay is a half-migration that cannot compile.
	if (overlays.length) {
		throw new Error(`"${name}" is overlaid by ${overlays.join(', ')} — an overlay cannot compile without its base, so removing the base alone would break the workspace. Remove the overlay first: dreamteamer remove-field ${name} --module <overlay-module> --name <field> (removing its last field removes the overlay).`);
	}
	const dest = path.join(ws.root, base);
	const dataDir = path.join(ws.root, d.storage.path);
	const hasRecords = fs.existsSync(dataDir) && fs.readdirSync(dataDir).some((e) => !e.startsWith('.'));
	if (hasRecords && !force) throw new Error(`collection "${name}" still has records under ${d.storage.path} — remove them first or pass force`);
	const gate = writeGated(ws, store, [dest], `dreamteamer: collections rm ${name}`, () => fs.rmSync(dest), undefined, { commentsMayDecrease: true });
	return { removed: name, commits: gate.commits };
}

/**
 * Rename a collection — descriptor, records, and every inbound reference, in ONE commit.
 *
 * This exists because namespacing EXISTING data was otherwise a hand migration: `git mv` the
 * descriptor, edit `name` and `storage.path`, `git mv` the record folder, re-suffix every file, then
 * find and rewrite every reference — six steps with no gate, where forgetting the last one dangles
 * every link silently. `dt collections rename doctors health/doctors` is the whole thing.
 *
 * DERIVED-VS-AUTHORED is the rule for both moving parts, the same rule `createCollection` uses:
 *  - `storage.path` moves only if it was DERIVED (equal to the default for the old name). An authored
 *    path is a deliberate choice about where records live and a rename must not overrule it.
 *  - `storage.suffix` is re-derived only if it was DERIVED (the singular of the old base name), because
 *    otherwise the filenames would start lying about what they hold. `doctors` → `health/doctors` keeps
 *    the base name, so nothing is re-suffixed — which is the common case and the cheap one.
 *
 * References are rewritten by asking the STORE to do it, in ONE batch of old→new pairs, rather than
 * by matching the collection prefix with a new regex. `store.rewriteRefsBatch` already knows the
 * boundary rules and already scopes prose to `[[wikilinks]]` (decision 7) — a fresh `oldName/`
 * pattern would have to relearn both, and would corrupt `data/tasks/` in a path or a URL on its
 * first outing.
 *
 * ⚠ IT USED TO BE O(records x files), TWICE, and the history is worth keeping because each stage was
 * measured and each was wrong about the one after it. Measured 2026-08-17 on a real 2,291-record
 * collection in a 3,391-file workspace: 3 minutes, 142s of it system time, 7.7M file reads to
 * rewrite ZERO references — the pass ran per id whether or not anything pointed at the collection.
 * Reproduced 2026-08-22 by `npm run perf -- --records=2291 --filler=1100`, which generates a
 * workspace that shape, and the real number was **15.6M reads, not 7.7M**: `captureRefs` walked
 * every record file for the rollback snapshot before `rewriteRefs` walked them all again, so 7.7M
 * was the PER-PASS number. That is what a generated fixture is for — the finding was right about the
 * shape and off by 2x on the count, and no comment could have told you.
 *
 * Both factors are gone as of 2026-09-01. The rewrite is one pass for every id, and the snapshot
 * pass disappeared entirely because the rewrite snapshots what it writes as it writes it.
 * `--records=400 --filler=100`, the same machine, best of three: 6.39s and 410,678 reads → 0.16s
 * and 1,075 — which is 504 files twice over, the batch pass and the `collections/<name>` one.
 */
export function renameCollection(ws, store, oldName, newName) {
	const d = store.descriptor(oldName); // throws with the known-collection list if absent
	if (!newName) throw new Error('missing new collection name');
	if (oldName === newName) return { renamed: false, name: newName };

	// ⚠ THE COMPILED SET (§8) — the declaration may live in any module's package.json now, and the
	// union is what compile stamped into the manifest.
	const declared = store.namespaces;
	if (newName.includes('/') && !namespaceOf(newName, declared)) {
		throw new Error(`namespace "${newName.slice(0, newName.lastIndexOf('/'))}" is not declared — declare it where the collection will live (dt set modules/<m> namespaces=<ns>), or in dreamteamer.namespaces for a workspace-level one.`);
	}
	if (store.descriptors.has(newName)) throw new Error(`collection "${newName}" already exists`);
	if (d.storage.base === 'runtime') throw new Error(`"${oldName}" is a compiled source, not a data collection — it cannot be renamed`);

	// The descriptor is renamed IN THE MODULE THAT SHIPS IT — see `descriptorSourceDir`. Two cases
	// this refuses, both because doing them halfway is worse than not doing them:
	const { dir: sourceDir, sources } = descriptorSourceDir(ws, oldName);
	if (sources.length > 1) {
		throw new Error(`"${oldName}" is overlaid — ${sources.length} modules contribute a descriptor (${sources.join(', ')}).\n  the overlay's \`extends\` names the base by its current id, so renaming the base alone would break it. merge or remove the overlay first.`);
	}
	if (sources.some((p) => p.split(path.sep).includes('node_modules'))) {
		throw new Error(`"${oldName}" ships from node_modules (${sources[0]}) — a write there is erased by the next \`npm install\`. rename it in its own repo and release, or overlay it with \`extends\`.`);
	}
	const src = sourceDir
		? path.join(sourceDir, `${oldName}.collection.yaml`)
		: path.join(workspaceSystemDir(ws, 'collections'), `${oldName}.collection.yaml`);
	const dest = path.join(sourceDir ?? workspaceSystemDir(ws, 'collections'), `${newName}.collection.yaml`);
	if (!fs.existsSync(src)) {
		throw new Error(`"${oldName}" has no writable descriptor source — the manifest names none under a module in this workspace. it may be contributed by the engine itself; overlay it with \`extends\` instead.`);
	}

	const doc = load(fs.readFileSync(src, 'utf8'));
	const dataPath = ws.pkg.dreamteamer?.['data-path'] ?? 'data';
	// `d` is the COMPILED descriptor, so its storage.path already carries any module prefix; the
	// authored source is what we compare against, and what we rewrite.
	const authoredPath = String(doc.storage?.path ?? '');
	const pathWasDerived = authoredPath === '' || authoredPath === defaultStoragePath(oldName, declared, dataPath);
	const newPath = pathWasDerived ? defaultStoragePath(newName, declared, dataPath) : authoredPath;

	const oldBase = baseNameOf(oldName, declared);
	const newBase = baseNameOf(newName, declared);
	const oldSuffix = d.storage.suffix;
	const suffixWasDerived = oldSuffix === singular(oldBase);
	const newSuffix = suffixWasDerived ? singular(newBase) : oldSuffix;

	// Every id BEFORE anything moves — the store's index is keyed on the old collection.
	const ids = [...store.ids(oldName).keys()];
	const oldDir = store.dir(d);
	const newDir = path.join(ws.root, newPath);
	if (newDir !== oldDir && fs.existsSync(newDir)) {
		throw new Error(`${newPath} already exists on disk — move or remove it first; nothing was renamed`);
	}

	// ---- rollback state, captured before the first mutation --------------------------------------
	const srcBytes = fs.readFileSync(src);
	let movedData = false;
	let resuffixed = [];
	const undo = () => {
		for (const [from, to] of resuffixed) { if (fs.existsSync(to)) fs.renameSync(to, from); }
		if (movedData && fs.existsSync(newDir)) {
			fs.mkdirSync(path.dirname(oldDir), { recursive: true });
			fs.renameSync(newDir, oldDir);
			pruneEmpty(path.dirname(newDir), path.join(ws.root, dataPath));
		}
		fs.mkdirSync(path.dirname(src), { recursive: true });
		fs.writeFileSync(src, srcBytes);
		if (dest !== src) fs.rmSync(dest, { force: true });
	};

	return store.withWriteLock(() => {
		// ⚠ THERE IS NO CAPTURE PASS ANY MORE. This used to ask `findInboundRefs` per id — a full walk
		// of every record file — purely to snapshot the referencing files for rollback, and then step 2
		// walked them all again to rewrite them: the same bytes read twice, per id. The rewrite
		// snapshots what it writes as it writes it (`store.rewriteRefsBatch`), so its own `restore` is
		// the rollback and the pre-walk is pure cost. `refFiles` is now step 4's descriptor sources
		// only, which no walk visits.
		const refFiles = new Map();
		const undoRewrites = [];
		const restoreRefs = () => {
			// reverse-chronological: one file can be written by both ref passes, and undoing the earlier
			// write first would leave the later one standing
			for (const u of [...undoRewrites].reverse()) u();
			for (const [f, bytes] of refFiles) {
				fs.mkdirSync(path.dirname(f), { recursive: true }); // pruneEmpty may have taken the parent
				fs.writeFileSync(f, bytes);
			}
		};

		const touched = new Set();
		let rewrites = 0;
		try {
			// 1. the descriptor source, at its new path — ROUND-TRIPPED, never re-dumped.
			//
			// ⚠ `fs.writeFileSync(dest, dump(doc))` destroyed every comment in the descriptor, and a
			// descriptor's comments are where this project keeps its reasoning: 194 lines across 24
			// files in one real migration, including 22-line headers stating what belongs in a
			// collection and which failure mode it guards against. The record survived; the thinking
			// did not, and nothing said so.
			//
			// A rename changes exactly three scalars, and `writeSource` rewrites exactly those three —
			// every other byte is restored from the source it was parsed out of. The parse afterwards
			// still proves the edit landed rather than trusting the writer, and the comment count is
			// asserted here because a rename does not go through `writeGated`'s invariant.
			const beforeText = srcBytes.toString('utf8');
			doc.name = newName;
			doc.storage = { ...doc.storage, path: newPath, suffix: newSuffix };
			const edited = writeSource(beforeText, doc);
			const parsed = load(edited);
			if (parsed?.name !== newName || parsed?.storage?.path !== newPath || parsed?.storage?.suffix !== newSuffix) {
				throw new Error(`could not rewrite ${path.relative(ws.root, src)} in place — name/storage.path/storage.suffix did not take. nothing was changed.`);
			}
			if (commentCount(edited) < commentCount(beforeText)) {
				throw new Error(`renaming "${oldName}" would lose ${commentCount(beforeText) - commentCount(edited)} comment line(s) from ${path.relative(ws.root, src)} — nothing was changed.`);
			}
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			fs.writeFileSync(dest, edited);
			if (dest !== src) fs.rmSync(src);
			touched.add(src);
			touched.add(dest);

			// 2. INBOUND REFERENCES FIRST, while the records are still where the store thinks they are.
			//
			// ⚠ This used to run AFTER the folder move and it silently missed every SELF-reference.
			// `store.rewriteRefs` walks `recordFiles()`, which resolves each collection's directory
			// from the descriptor loaded when the Store was built — i.e. the OLD `storage.path`. Move
			// the records first and that walk finds an empty directory, so a record pointing at its
			// own collection is never rewritten and dangles the moment compile catches up.
			//
			// It is not a corner case: it hit `finance/accounts`, where every card and loan carries
			// `settled_by: <the account that settles it>` — 5 dangling refs out of 11 records, found
			// only because `check` ran afterwards. Doing the rewrite first needs no descriptor reload
			// and no second code path: the files are still at the old path, which is exactly what the
			// old refs say.
			// ONE pass for every id, not one pass per id — see `store.rewriteRefsBatch`. The
			// `collections/<name>` retarget stays its own call: it is a different ref (into the
			// `collections` collection), and folding it in would put a needle in the batch that shares
			// no prefix with the rest and so switch the negative pre-filter off for all of them.
			const out = store.rewriteRefsBatch(ids.map((id) => [`${oldName}/${id}`, `${newName}/${id}`]));
			undoRewrites.push(out.restore);
			rewrites += out.rewrites;
			for (const f of out.touched) touched.add(f);
			const collOut = store.rewriteRefs(`collections/${oldName}`, `collections/${newName}`);
			undoRewrites.push(collOut.restore);
			rewrites += collOut.rewrites;
			for (const f of collOut.touched) touched.add(f);

			// 3. the record folder, then the per-file suffix if it was derived
			if (newDir !== oldDir && fs.existsSync(oldDir)) {
				fs.mkdirSync(path.dirname(newDir), { recursive: true });
				fs.renameSync(oldDir, newDir);
				movedData = true;
				pruneEmpty(path.dirname(oldDir), path.join(ws.root, dataPath));
			}
			if (newSuffix !== oldSuffix && fs.existsSync(newDir)) {
				// Match on the OLD suffix, keep whatever extension the file already had — an opaque
				// record's extension is its own, and a re-suffix must not rename it into another format.
				const old = { storage: { ...d.storage, suffix: oldSuffix } };
				for (const file of walk(newDir)) {
					const id = idFromRecordPath(old, path.relative(newDir, file));
					if (id === null) continue;
					const to = path.join(newDir, `${id}.${newSuffix}${path.basename(file).slice(path.basename(id).length + oldSuffix.length + 1)}`);
					fs.renameSync(file, to);
					resuffixed.push([file, to]);
				}
			}
			if (movedData) { touched.add(oldDir); touched.add(newDir); }

			// 4. bare `x-reference: <oldName>` in every descriptor SOURCE. Not a `<collection>/<id>`
			//    ref, so step 2 cannot see it — and leaving it makes compile fail on an unknown target.
			//
			// ⚠ ROUND-TRIPPED, for the same reason step 1 is. This used to `load` → mutate → `dump`, which
			// meant that ANY descriptor needing a retarget lost every comment in it — including the
			// renamed one itself when it self-references, which is how step 1's careful preservation
			// was undone one step later. 17 of the 24 descriptors stripped in the migration that
			// found this were stripped HERE, not there.
			//
			// `retargetRefs` decides whether a file is affected AND performs the edit on the parsed value
			// — it walks nested properties and `items` — and `writeSource` puts that value back over the
			// original bytes. The line editor this replaced had to know THREE spellings by hand (block
			// scalar, inline flow, and a flow or block LIST) and fell through unchanged on three more it
			// documented as out of scope; a value-level edit knows all of them because it never sees
			// syntax. The parse afterwards still proves it landed.
			for (const f of descriptorSources(ws, store)) {
				const before = fs.readFileSync(f, 'utf8');
				const probe = load(before);
				if (!probe || !retargetRefs(probe.schema, oldName, newName)) continue;
				const after = writeSource(before, probe);
				const reparsed = load(after);
				if (!reparsed || retargetRefs(reparsed.schema, oldName, newName) || commentCount(after) < commentCount(before)) {
					throw new Error(`could not retarget x-reference "${oldName}" in ${path.relative(ws.root, f)} without reformatting it — nothing was changed.`);
				}
				if (!refFiles.has(f)) refFiles.set(f, Buffer.from(before));
				fs.writeFileSync(f, after);
				touched.add(f);
				rewrites++;
			}

			compile(ws); // the gate: an uncompilable rename never reaches history
		} catch (e) {
			// ⚠ undo() FIRST. A captured file can be a SELF-reference — a record of the collection being
			// renamed — so its path only exists again once undo() has moved the folder back. Restoring
			// before that wrote into a directory that was no longer there, and the ENOENT masked the
			// error actually being rolled back from.
			undo();
			restoreRefs();
			try { compile(ws); } catch { /* pre-rename sources were compilable */ }
			throw e;
		}

		// The pathspec filter now lives in `commitByRepo`, per repo — `isTracked` has to run in the
		// repo that would track the path, and running it at the workspace root answered "no" for
		// every path inside a git-shape module.
		const rels = [...touched].map((f) => path.relative(ws.root, f));
		let commits;
		try {
			commits = commitByRepo(ws, store, rels, `dreamteamer: collections rename ${oldName} → ${newName}`);
		} catch (e) {
			undo();
			restoreRefs();
			try { compile(ws); } catch { /* pre-rename sources were compilable */ }
			throw new Error(`git commit failed — the rename was rolled back, nothing was changed. (${e.message.split('\n')[0]})`);
		}

		return {
			renamed: true, name: newName, records: ids.length, rewrites, commits,
			from: path.relative(ws.root, oldDir), to: path.relative(ws.root, newDir),
			suffix: newSuffix !== oldSuffix ? { from: oldSuffix, to: newSuffix } : null,
			pathKept: pathWasDerived ? null : authoredPath,
		};
	});
}

/** Does git know this path? A deleted-and-never-committed file must be dropped from a pathspec. */
function isTracked(root, rel) {
	try {
		execFileSync('git', ['ls-files', '--error-unmatch', '--', rel], { cwd: root, stdio: ['ignore', 'ignore', 'ignore'] });
		return true;
	} catch { return false; }
}

/**
 * ONE COMMIT PER REPO, in the repo that actually holds each source.
 *
 * ⚠ THE DEFECT THIS FIXES WAS SILENT ABOUT ITS OWN CAUSE. Every schema commit ran at the WORKSPACE
 * root, and `git_modules/` is gitignored there — so `git add -- git_modules/hr/collections/…` added
 * nothing, the pathspec-scoped `git commit` had nothing to record and failed, and the gate rolled
 * the whole op back with a message naming git. A schema write into a git-shape module was therefore
 * impossible, and the reason was invisible: the source compiled, the field was live for one
 * instant, and then the file was restored.
 *
 * `repoRootOf` (compile.js, there since `owns-data` needed it) answers "which repo holds this path"
 * — nearest `.git` at or above it, workspace-relative, `.` for the workspace itself. Grouping by it
 * is the whole fix.
 *
 * Returns `[{repo, sha, ahead}]` so the caller can say WHERE the change landed. `ahead` is the count
 * of commits the repo has that its upstream does not — meaningful only for a clone, and `null` for
 * the workspace, whose publishing story is `git push` like any repo the operator already thinks
 * about.
 *
 * ⚠ ALL-OR-NOTHING ACROSS REPOS IS NOT ACHIEVABLE and is not claimed. Two repos cannot commit
 * atomically. So the FIRST failure aborts, the caller's `undo` restores every source in every repo,
 * and any commit already made is left standing with its own subject — which is honest and
 * inspectable, unlike a partial write with no history. `dt status` then shows the drift. Extending
 * `dt commit` to module sources is the follow-on this file has always named; it is not this wave.
 */
function commitByRepo(ws, store, rels, subject) {
	const byRepo = new Map(); // workspace-relative repo root -> {root, paths relative to THAT repo}
	for (const rel of new Set(rels)) {
		const abs = path.join(ws.root, rel);
		// A path that is neither on disk nor in any index cannot be a pathspec, and one bad entry
		// aborts the whole `git add` — the lesson `renameCollection` paid for. ⚠ The filter runs PER
		// REPO: `isTracked` has to run in the repo that would track the path, and running it at the
		// workspace root answered "no" for every path inside a clone.
		const repo = repoRootOf(path.dirname(abs), ws.root);
		const repoAbs = repo === '.' ? ws.root : path.join(ws.root, repo);
		const inRepo = path.relative(repoAbs, abs);
		if (!fs.existsSync(abs) && !isTracked(repoAbs, inRepo)) continue;
		if (!byRepo.has(repo)) byRepo.set(repo, { root: repoAbs, paths: [] });
		byRepo.get(repo).paths.push(inRepo);
	}
	const out = [];
	try {
		for (const [repo, { root, paths }] of byRepo) {
			execFileSync('git', ['add', '--all', '--', ...paths], { cwd: root, stdio: GIT_QUIET });
			execFileSync('git', ['commit', '--quiet', '-m', subject, '--', ...paths], { cwd: root, stdio: GIT_QUIET });
			out.push({ repo, sha: shortHead(root), ahead: repo === '.' ? null : aheadCount(root) });
		}
	} catch (e) {
		// unstage everything this call touched, in every repo, before handing the failure back
		for (const [, { root, paths }] of byRepo) {
			try { execFileSync('git', ['reset', '--quiet', '--', ...paths], { cwd: root, stdio: GIT_QUIET }); } catch { /* nothing staged */ }
		}
		e.commits = out; // what DID land, for the caller's message
		throw e;
	} finally {
		store.headMoved(); // this ran `git commit` — see store.gitHead
	}
	return out;
}

const shortHead = (root) => {
	try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, stdio: GIT_QUIET }).toString().trim(); } catch { return null; }
};

/** How many commits this repo has that its upstream does not. Falls back to "not on any remote",
 *  because a fresh `dt install --clone` has no upstream configured and "ahead of nothing" is not a
 *  number the report can print. */
function aheadCount(root) {
	try {
		const n = execFileSync('git', ['rev-list', '--count', '@{upstream}..HEAD'], { cwd: root, stdio: GIT_QUIET }).toString().trim();
		return Number(n);
	} catch {
		try {
			const n = execFileSync('git', ['rev-list', '--count', 'HEAD', '--not', '--remotes'], { cwd: root, stdio: GIT_QUIET }).toString().trim();
			return Number(n) || 1;
		} catch { return 1; }
	}
}

/** Every workspace-owned descriptor source, recursively (namespaced descriptors are nested). */
function descriptorSources(ws, store) {
	const out = [];
	for (const root of store.sourceRoots()) {
		const dir = kindDir(root, 'collections');
		// ⚠ SPREAD FIRST. `walk` is a GENERATOR, and `Iterator.prototype.filter` is a Node 22 iterator
		// helper — so `walk(dir).filter(...)` works on 22 and throws "filter is not a function" on 20,
		// which package.json still supports (`"node": ">=20"`). Caught by the CI matrix, not by local runs.
		if (fs.existsSync(dir)) out.push(...[...walk(dir)].filter((f) => f.endsWith('.collection.yaml')));
	}
	return out;
}

/** Rewrite `x-reference: old` → new anywhere in a schema — scalar or list entry. Returns true if anything changed. */
function retargetRefs(schema, oldName, newName) {
	let changed = false;
	for (const prop of Object.values(schema?.properties ?? {})) {
		if (!prop || typeof prop !== 'object') continue;
		for (const holder of [prop, prop.items]) {
			if (!holder || typeof holder !== 'object') continue;
			if (holder['x-reference'] === oldName) {
				holder['x-reference'] = newName;
				changed = true;
			} else if (Array.isArray(holder['x-reference'])) {
				const i = holder['x-reference'].indexOf(oldName);
				if (i !== -1) {
					holder['x-reference'][i] = newName;
					changed = true;
				}
			}
		}
		if (prop.properties && retargetRefs(prop, oldName, newName)) changed = true;
		if (prop.items?.properties && retargetRefs(prop.items, oldName, newName)) changed = true;
	}
	return changed;
}

/** Remove now-empty parents up to (not including) the data root — a moved collection leaves its
 *  namespace folder behind otherwise. */
function pruneEmpty(dir, stopAt) {
	while (dir !== stopAt && dir.startsWith(stopAt) && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
		fs.rmdirSync(dir);
		dir = path.dirname(dir);
	}
}

/**
 * THE MIRROR VALUES A DROPPED RELATION LEAVES BEHIND.
 *
 * `update-field --name meeting --inverse=` removes the mirror from the compiled descriptor and does
 * nothing else, so the values the relation generated stay in every target record — in a field the
 * schema no longer declares. The next `check` then said:
 *
 *   ✖ data/meetings/kickoff.meeting.md
 *       unknown field "recordings" (not in the meetings schema)
 *
 * …on N records. A sentence that reads like a typo, for a state the schema op itself created one
 * command earlier, with the repair (`relations rebuild <target> --drop <mirror>`) named nowhere.
 *
 * So the op that creates the staleness cleans it up, in the same write and the same commit. That is
 * the contract every RECORD write already honours — add/set/rm/revert maintain the far side of a
 * relation rather than leaving it to a repair verb — and there is no reason a schema write should be
 * the exception.
 *
 * ⚠ SCOPED TO THE FIELD BEING EDITED, deliberately, and not to "every relation that disappeared from
 * the graph". A whole-graph diff would also fire when the runtime was stale before the op for
 * unrelated reasons, which means a `dt schema add-field` on collection A rewriting records of C — a
 * commit sweeping records nobody named, which is the one thing this repo's rule 6 exists to stop.
 *
 * Returns the `{files, undo}` shape `store.applyMirrorEdits` returns, so writeGated can put the
 * writes in its commit and unwind them with the source if the commit fails, plus `dropped` for the
 * report: an operator told a mirror was removed needs to know N records changed with it.
 */
function dropOrphanedMirrors(store, was) {
	// ⚠ The Store the caller passes must be built from the runtime AFTER the gate compile: the one the
	// verb started with still declares the mirror, which is exactly the question being asked.
	const now = store.relations();
	const files = [], undos = [], dropped = [];
	for (const r of was) {
		if (now.some((n) => n.owner === r.owner && n.field === r.field && n.target === r.target && n.mirror === r.mirror)) continue;
		// The target may have gone with the relation (`collections rm`), and a target that never held a
		// mirror (`codec: file`, a compiled source) has nothing to clean — compile refuses those, so
		// this is the belt to that brace.
		if (!store.descriptors.has(r.target) || !store.canRewrite(r.target)) continue;
		// ⚠ AND THE KEY MAY STILL BE LIVE. A RENAMED x-inverse reads as one relation gone and another
		// arrived; if the new one stamps the same name, or the author declared a real field there, the
		// values are data rather than residue.
		if (store.descriptor(r.target).schema?.properties?.[r.mirror] !== undefined) continue;
		const d = store.descriptor(r.target);
		const bf = bodyField(d);
		let records = 0;
		for (const [, file] of store.ids(r.target)) {
			let fields;
			// A record that will not parse is SKIPPED, not fatal: `check` already reports the syntax
			// error, and refusing an unrelated schema edit over it would make one bad record a wall.
			try { fields = parseRecord(file, d, bf); } catch { continue; }
			if (!(r.mirror in fields)) continue;
			const previous = fs.readFileSync(file, 'utf8');
			delete fields[r.mirror];
			atomicWrite(file, serialize(d, fields));
			files.push(file);
			undos.push(() => atomicWrite(file, previous));
			records++;
		}
		if (records) dropped.push({ target: r.target, mirror: r.mirror, records });
	}
	return { files, undo: () => { for (const u of [...undos].reverse()) u(); }, dropped };
}

/**
 * Clear one field's values from every record of a collection — the other half of removing it.
 *
 * `remove-field` deleted the field from the schema and left the values in the files, which left the
 * whole collection READABLE AND UNWRITABLE: the key is now an unknown field, so `check` reports it
 * and the store refuses the next write to that record. Nothing said so, and a record write could not
 * fix it — `dt set <c>/<id> field=` writes `field: []`, which is still the key. The only repair was
 * `relations rebuild <c> --drop <field>`, a verb whose name says "relations" for a field that may
 * have nothing to do with them, and which nobody was told to run.
 *
 * So the op that creates the staleness cleans it up, in the same write and the same commit — the
 * general case of what `dropOrphanedMirrors` does for a mirror, and the contract every RECORD write
 * already honours.
 *
 * ⚠ THIS DELETES DATA, deliberately, and for a relation's OWNING key those values are real authored
 * references rather than derived state — removing the field clears them too, and that is correct
 * because the field is gone. Removing a field is an explicit destructive schema act; this runs inside
 * writeGated's commit, so the previous values are one `git show HEAD~1` away. The alternative —
 * refusing unless `--force` — is a dead end that puts a CLI flag in the middle of a UI gesture. The
 * COUNT is returned and printed for exactly this reason: a silent deletion and a reported one are
 * different acts.
 *
 * ⚠ THE BODY FIELD IS THE ONE EXCEPTION, and it needs none of this. With the field gone,
 * `bodyField(d)` no longer names it, so the prose is not parsed into `fields` at all — nothing here
 * matches it, nothing is rewritten, and the text stays in the file as an ordinary Markdown body that
 * no schema field claims. `check` is silent on it, correctly.
 */
function clearFieldValues(store, collection, fieldName) {
	const d = store.descriptors.get(collection);
	// A `codec: file` record has no serialised fields, and a compiled-source collection is a build
	// artifact — neither can be carrying a value of a field, and neither may be rewritten.
	if (!d || !store.canRewrite(collection)) return { files: [], undo: () => {}, records: 0 };
	const bf = bodyField(d);
	const files = [], undos = [];
	for (const [, file] of store.ids(collection)) {
		let fields;
		// A record that will not parse is SKIPPED rather than fatal: `check` already reports the syntax
		// error, and refusing the schema edit over it would make one bad record a wall.
		try { fields = parseRecord(file, d, bf); } catch { continue; }
		if (!(fieldName in fields)) continue;
		const previous = fs.readFileSync(file, 'utf8');
		delete fields[fieldName];
		atomicWrite(file, serialize(d, fields));
		files.push(file);
		undos.push(() => atomicWrite(file, previous));
	}
	return { files, undo: () => { for (const u of [...undos].reverse()) u(); }, records: files.length };
}

/** The relations the field being edited owns RIGHT NOW — the "before" half of the question above,
 *  read before the source is touched. Empty for a field that does not exist yet, which is what makes
 *  `add-field` share this path without a branch. */
function relationsOwnedBy(store, collection, fieldName) {
	return store.relations().filter((r) => r.owner === collection && r.field === fieldName);
}

export function addField(ws, store, collection, { name: fieldName, prop, required, moduleId }) {
	store.descriptor(collection); // must exist in the compiled runtime
	if (!fieldName) throw new Error('missing field name');
	// ⚠ On an OVERLAY, a field the base already declares is an OVERRIDE, not a duplicate — that is
	// what `extends` is for. Only a write to the base itself can collide.
	const target = collectionSourceFile(ws, store, collection, moduleId, { allowNew: true, subject: `${collection}.${fieldName}` });
	if (!target.overlay && store.descriptor(collection).schema?.properties?.[fieldName]) {
		throw new Error(`field "${fieldName}" already exists on ${collection}`);
	}
	return upsertField(ws, store, collection, fieldName, prop, required, `add-field ${fieldName}`, target);
}

/** The relation keywords a caller is RESTATING, from the flag vocabulary the CLI and the HTTP schema
 *  API both speak. A stated keyword replaces the previous value — INCLUDING with nothing, so
 *  `--unique false` clears rather than carries; an unstated one is carried forward from the previous
 *  prop. ⚠ `--many` is deliberately absent: it restates a reference's CARDINALITY, not the reference,
 *  so "make this a list" must not sever the relation. */
export function statedKeywords(flags) {
	const byFlag = { type: 'x-reference', inverse: 'x-inverse', unique: 'x-unique', 'on-delete': 'x-on-delete', 'mirror-of': 'x-inverse-of' };
	return new Set(Object.entries(byFlag).filter(([f]) => flags[f] !== undefined).map(([, kw]) => kw));
}

/** Every keyword a caller could state — the default, because a caller that says nothing about what
 *  it stated has supplied a WHOLE prop (server.js's `b.prop` path) and nothing may be carried into
 *  it behind its back. */
const ALL_RELATION_KEYWORDS = new Set(['x-reference', 'x-inverse', 'x-unique', 'x-on-delete', 'x-inverse-of']);

export function updateField(ws, store, collection, fieldName, { prop, required, flags = {}, stated, moduleId }) {
	// Did the caller build this prop from the FLAG VOCABULARY, or hand over a whole field? `stated` is
	// how it says so (see ALL_RELATION_KEYWORDS): a flag-built prop is only what the flags could
	// express, so the rest is carried; a whole prop IS the field, and nothing may be carried into it
	// behind its back.
	const fromFlags = stated !== undefined;
	stated ??= ALL_RELATION_KEYWORDS;
	const d = store.descriptor(collection);
	if (!d.schema?.properties?.[fieldName]) throw new Error(`no field "${fieldName}" on ${collection}`);
	// upsertField REPLACES the prop, so retyping a field would silently drop its hand-authored
	// `description`. Changing a field's type is not a decision to undocument it. Same for an
	// authored `title` — but ONLY an authored one: a derived title is compile's output, not a
	// human's choice, and `titleCase` is how the two are told apart.
	// ⚠ THE AUTHORED PROP, not the compiled one — see authoredField. Carrying compile's own derivation
	// back into a source is how `update-field <owner> --name <fk> --description "…"` turned a
	// spelling-B relation into one declared on BOTH sides. The compiled prop is the base only where no
	// source declares the field, i.e. an inherited field being overridden here for the first time.
	const previous = authoredField(ws, collection, fieldName).prop ?? d.schema.properties[fieldName];
	if (prop.description === undefined && typeof previous.description === 'string') prop = { ...prop, description: previous.description };
	if (prop.title === undefined && typeof previous.title === 'string' && previous.title !== titleCase(fieldName)) prop = { ...prop, title: previous.title };
	// `x-body` is STRUCTURE, not prose, and carried on the same rule as the relation keywords below:
	// `update-field --name notes --description "…"` rebuilds the prop from the flags alone, so without
	// this a retype would silently un-body the field — the record's text then parses into nothing and
	// the next write serializes it away. `--body false` is how you clear it.
	if (flags.body === undefined && previous['x-body'] === true) prop = { ...prop, 'x-body': true };

	// ⚠ WITHOUT `--type`, THE PREVIOUS SHAPE STANDS — and this is the same silent-corruption class the
	// relation carry below closed, except that carry named five keywords and the problem is EVERY
	// keyword. `fieldDef` builds a prop from the flags ALONE, so a call that named no type came back
	// `{type: string}` — not a statement about the field, just the default of a function that was told
	// nothing — and `upsertField` writes the prop it is handed. So
	// `dt schema update-field <c> --name <f> --description "…"` RETYPED every field it touched.
	// Measured, one description-only edit each:
	//
	//   prose  {type: string, format: markdown, x-body: true} → {type: string}  a body field, no longer one
	//   due    {type: string, format: date}                   → {type: string}
	//   status {type: string, enum: [todo, doing, done]}       → {type: string}  the constraint gone
	//   labels {type: array,  items: {type: string}}           → {type: string}  a list became a scalar
	//   score  {type: number, default: 3, minimum: 0, max: 10} → {type: string}  a number became a string
	//
	// Every one a data-shape change nothing announced, and the ones that WIDEN are invisible to
	// `check` — a string field accepts everything the number field held. The rule: a flag that was
	// passed speaks for the keywords it owns, and everything else comes from the previous prop.
	// `--type` still owns the whole shape, so a deliberate retype behaves exactly as it did.
	if (fromFlags && flags.type === undefined) {
		// `title` and `description` have their own rules above (a DERIVED title is not an override);
		// the relation keywords have theirs below, because `--unique false` clears rather than carries.
		// A flag CLEARS what it names, so a stated one keeps the carry off even when its value was
		// falsey — the `--unique false` precedent. Everything else is filled only where the rebuilt
		// prop has nothing to say, which is what makes a restating flag still win.
		const spokenFor = new Set(['title', 'description']);
		if (flags.body !== undefined) spokenFor.add('x-body');
		if (flags.many !== undefined) { spokenFor.add('type'); spokenFor.add('items'); } // cardinality, restated
		// `--options` alone restates an EXISTING enum's values. `fieldDef` cannot: its enum case needs
		// `--type enum`, so without this the carry below would put the OLD values back and
		// `update-field --options open,shut` would be a silent no-op — trading one quiet wrong answer
		// for another.
		if (flags.options !== undefined && previous.enum !== undefined) {
			prop = { ...prop, enum: optionList(flags.options) };
			spokenFor.add('enum');
		}
		// `type` explicitly, because `fieldDef` always emits one: with no `--type` that value is the
		// default of a function that was told nothing, not a statement, so it loses to the previous.
		if (!spokenFor.has('type')) prop = { ...prop, type: previous.type ?? prop.type };
		for (const [k, v] of Object.entries(previous)) {
			if (spokenFor.has(k) || ALL_RELATION_KEYWORDS.has(k) || prop[k] !== undefined) continue;
			prop[k] = structuredClone(v);
		}
		// …and now that the type is known, a STATED default can be coerced against it. fieldDef could
		// not: it was told no type, so `--default-value 7` on a number field became the string "7".
		if ((flags['default-value'] ?? flags.default) !== undefined && prop.default !== undefined) {
			prop.default = coerceDefault(prop.type, prop.default);
		}
		// A carried `items` must arrive EMPTY of relation keywords, or `--inverse=` could not clear the
		// mirror: the carry below is what re-applies them, and it only fills what is undefined.
		if (prop.items && typeof prop.items === 'object') {
			prop.items = { ...prop.items };
			for (const kw of ALL_RELATION_KEYWORDS) delete prop.items[kw];
		}
	}

	// Relation keywords are STRUCTURE, not prose — and the same replacement is far more expensive
	// for them. `dt <c> update-field --name meeting --description "…"` rebuilt the prop from
	// `fieldDef` with no `--type`, so it wrote back a plain `{type: string}`: the foreign key was
	// gone, the mirror on the other side had no owner, and nothing said so. Each keyword is carried
	// forward from the previous prop unless a flag NAMES it.
	const prevHolder = previous.items ?? previous;
	const holder = () => prop.items ?? prop;
	// The reference this field ends up with: the one the caller stated, else the one carried forward.
	const ref = holder()['x-reference'] ?? (stated.has('x-reference') ? undefined : prevHolder['x-reference']);
	// ⚠ CARDINALITY IS `--many`'S TO CHANGE, NEVER `--type`'S — and it is decided outside the carry,
	// because restating `--type meetings` on an array FK used to collapse it to a scalar and `check`
	// could not see it: ajv runs with `coerceTypes: 'array'` and unwraps a one-element list, so every
	// single-valued record passed. Two elements was caught; one was not.
	const wantsArray = flags.many === undefined ? previous.type === 'array' : isOn(flags.many);
	if (ref !== undefined) {
		if (wantsArray && prop.type !== 'array') {
			// hoist onto `items` — the node every relation consumer reads keywords from, and where the
			// ones fieldDef put on the scalar prop have to move to
			const items = { type: previous.items?.type ?? 'string' };
			for (const kw of ALL_RELATION_KEYWORDS) if (prop[kw] !== undefined) items[kw] = prop[kw];
			prop = { ...prop, type: 'array', items };
			for (const kw of ALL_RELATION_KEYWORDS) delete prop[kw];
			delete prop.format;
		}
		holder()['x-reference'] = ref;
	}
	// The dependent keywords only mean anything ON a reference, so a deliberate retype to a plain
	// string takes them with it rather than leaving an uncompilable orphan behind.
	if (holder()['x-reference'] !== undefined) {
		for (const kw of ALL_RELATION_KEYWORDS) {
			if (kw === 'x-reference' || stated.has(kw)) continue;
			if (prevHolder[kw] !== undefined && holder()[kw] === undefined) holder()[kw] = prevHolder[kw];
		}
		// Then the STATED ones, on top: fieldDef deferred them because the prop it built from the
		// flags alone carried no reference — this is the migration path, where `update-field --name
		// meeting --inverse` turns a plain FK written before relations existed into a relation. It
		// runs AFTER the carry so a carried `x-unique` still informs a bare `--inverse`, and it runs
		// on the holder the reshape above produced rather than the one fieldDef saw.
		applyRelationFlags(holder(), flags, collection, store.namespaces ?? []);
	} else if (relationFlagsStated(flags)) {
		throw new Error(`--${relationFlagsStated(flags)} needs a --type <collection> reference — ${collection}.${fieldName} points at nothing.`);
	}

	return upsertField(ws, store, collection, fieldName, prop, required, `update-field ${fieldName}`,
		collectionSourceFile(ws, store, collection, moduleId, { subject: `${collection}.${fieldName}` }));
}

/**
 * A field as its own SOURCES declare it — the authored truth — plus which files declare it.
 *
 * ⚠ NOT the compiled prop, and the difference is load-bearing twice. THE COMPILED OUTPUT IS
 * IDENTICAL FOR BOTH RELATION SPELLINGS — that is materializeRelations' whole point, one compiled
 * pair from either source form — so a compiled prop cannot say which side DECLARED a relation, and
 * it carries keywords no source ever authored: `foldMirrorSide` writes `x-inverse` and `x-unique`
 * onto the OWNER when the far side used spelling B. Reading a prop out of the compiled descriptor
 * and writing it back into a source therefore did two bad things, both measured on 0.15.0:
 *
 *   - `remove-field` on a spelling-B mirror answered "no descriptor declares it" while the file that
 *     declared it sat in front of the operator, and named a remedy that exits 0 changing nothing.
 *   - `update-field <owner> --name <fk> --description "…"` carried compile's DERIVED `x-inverse` and
 *     `x-unique` into the owner's source, so the relation was then declared on both sides and every
 *     compile afterwards printed `⚠ relation …: declared on both sides — keep one`. That is the same
 *     defect the extension was writing from its own save path.
 *
 * Sources are merged in manifest order (base, then any `extends` overlay), which is the order compile
 * merges them, so an overlay's keywords win exactly as they do there.
 */
function authoredField(ws, collection, fieldName) {
	const files = [];
	let prop;
	for (const rel of descriptorSourceDir(ws, collection).sources) {
		const file = path.join(ws.root, rel);
		if (!fs.existsSync(file)) continue;
		const own = load(fs.readFileSync(file, 'utf8'))?.schema?.properties?.[fieldName];
		if (own === undefined || own === null || typeof own !== 'object') continue;
		prop = prop === undefined ? structuredClone(own) : { ...prop, ...structuredClone(own) };
		files.push(rel);
	}
	return { prop, files };
}

/**
 * Why this field cannot be removed HERE — and the answer depends entirely on WHERE it is declared.
 *
 * Reached only when the descriptor this verb edits does not carry the field. Three different
 * situations arrive here and they need three different sentences; answering all of them off the
 * compiled prop's `x-inverse-of` produced one that was false twice over on the spelling every
 * relation in the dogfood vault uses (see authoredField for why the compiled prop cannot tell them
 * apart).
 */
function refuseUnremovableField(ws, d, collection, fieldName, hasOwnDoc) {
	const prop = d.schema.properties[fieldName];
	const holder = (prop.items && typeof prop.items === 'object') ? prop.items : prop;
	const of = holder['x-inverse-of'];
	if (typeof of === 'string') {
		// SPELLING B: the field is declared on THIS collection with `x-inverse-of`, compile folds that
		// declaration into the owner and regenerates the field under the same key — so a source still
		// carrying it IS the relation, and deleting it there is the removal. Name the file.
		const declaring = authoredField(ws, collection, fieldName).files;
		if (declaring.length) {
			throw new Error(`field "${fieldName}" on ${collection} DECLARES a relation (x-inverse-of: ${of}) in ${declaring.join(', ')} — that declaration is the relation, so deleting the field there removes it. This verb edits ${collection}'s base descriptor, which does not carry it.`);
		}
		// SPELLING A: nothing here declares it; compile stamped it from the owner's `x-inverse`, and
		// clearing that keyword is the removal. This remedy WORKS — the spelling-B one did not, because
		// the owner never carried an `x-inverse` to clear.
		const dot = of.lastIndexOf('.'); // a collection name may contain '/', so split at the LAST dot
		throw new Error(`field "${fieldName}" on ${collection} is GENERATED from ${of}, the two-way relation that owns it — no source of ${collection} declares it, so no edit here can remove it. Remove the relation instead: dreamteamer schema update-field ${of.slice(0, dot)} --name ${of.slice(dot + 1)} --inverse=`);
	}
	// ⚠ These two sentences used to name the WORKSPACE module, because that is where this verb wrote.
	// It now writes in the module that OWNS the collection, so "the workspace descriptor" was a fact
	// about the old routing — and naming the wrong file is how a correct refusal reads as a bug.
	throw new Error(hasOwnDoc
		? `field "${fieldName}" is inherited — ${collection}'s own descriptor does not declare it, so there is nothing here to remove. Override it instead: dreamteamer add-field ${collection} --name ${fieldName} … --module <your-module>`
		: `"${collection}" ships from a source this workspace cannot rewrite; it can only OVERRIDE fields (extends), not remove them`);
}

/**
 * The ui-views whose columns still name a field that is going away — reported, never edited.
 *
 * The line is ownership. `list_fields` and `sort_field` live in the descriptor this verb already
 * rewrites, and they are that FIELD's presentation, so they go with it (see removeField). A ui-view
 * is a different source, shipped by whichever module ships it, and it may be carrying a deliberate
 * layout somebody tuned — so the verb says which views it just invalidated and leaves them alone.
 * Silently editing somebody else's source is the worse of the two failures.
 *
 * Columns are matched as plain names, the same vocabulary `list_fields` uses. `options` is
 * deliberately open (each layout wants different things), so anything else in there is not a column.
 */
function viewsNamingField(store, collection, fieldName) {
	if (!store.descriptors.has('ui-views')) return [];
	return [...store.readAll('ui-views')]
		.filter((v) => v.fields.collection === `collections/${collection}`
			&& (v.fields.options?.columns ?? []).includes(fieldName))
		.map((v) => v.id);
}

export function removeField(ws, store, collection, fieldName, { moduleId } = {}) {
	const d = store.descriptor(collection);
	if (!d.schema?.properties?.[fieldName]) throw new Error(`no field "${fieldName}" on ${collection}`);
	const staleViews = viewsNamingField(store, collection, fieldName);
	// Removing the OWNING foreign key drops the relation just as `--inverse=` does, and leaves the
	// same residue on the target. Same sweep, same commit.
	const was = relationsOwnedBy(store, collection, fieldName);
	const dest = collectionSourceFile(ws, store, collection, moduleId, { subject: `${collection}.${fieldName}` }).file;
	const previousText = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
	const doc = previousText === null ? null : load(previousText);
	// ⚠ ASK THE SOURCE THIS VERB EDITS, and ask it FIRST. A field the descriptor declares is removable
	// from it, whatever the compiled prop says about it — including a relation authored here with
	// `x-inverse-of`, where that declaration IS the relation and deleting it is the whole removal.
	// Deciding this off the compiled prop instead refused the ordinary case with a sentence
	// ("no descriptor declares it") that the file in front of the operator disproved.
	if (doc?.schema?.properties?.[fieldName] === undefined) {
		refuseUnremovableField(ws, d, collection, fieldName, doc !== null);
	}
	const out = writeGated(ws, store, [dest], `dreamteamer: ${collection} remove-field ${fieldName}`, () => {
		delete doc.schema.properties[fieldName];
		if (Array.isArray(doc.schema.required)) doc.schema.required = doc.schema.required.filter((r) => r !== fieldName);
		// THE FIELD'S OWN PRESENTATION, IN THIS SAME FILE, GOES WITH IT. `list_fields` and `sort_field`
		// naming a field that no longer exists are not independent facts about the collection; removing
		// the field is an explicit act and pruning them is what the operator meant. Left behind they
		// failed in two different silent ways: a dangling `list_fields` entry compiled clean and put a
		// dead column in every default listing, and a dangling `sort_field` made compile REFUSE the
		// removal — the verb that owns this descriptor telling the operator to go hand-edit it.
		// The key is DROPPED rather than left `[]`, because a listing of no columns is a statement
		// nobody made; absent means "no opinion", which is what it said before the field existed.
		if (Array.isArray(doc.list_fields)) {
			doc.list_fields = doc.list_fields.filter((c) => c !== fieldName);
			if (!doc.list_fields.length) delete doc.list_fields;
		}
		if (doc.sort_field === fieldName) delete doc.sort_field;
		// ⚠ AN OVERLAY WHOSE LAST FIELD IS GONE IS NOT A DESCRIPTOR ANYBODY MEANT TO KEEP. An
		// `extends:` descriptor contributing no properties adds nothing to the merge and is a source
		// the next reader has to work out the purpose of; §5's stated rule is that removing its last
		// field removes the file.
		if (doc.extends && !Object.keys(doc.schema?.properties ?? {}).length) fs.rmSync(dest);
		else fs.writeFileSync(dest, writeSource(previousText, doc));
	}, () => {
		// ONE Store for both sweeps — the runtime as the gate compile just left it.
		const after = new Store(ws);
		const mirrors = dropOrphanedMirrors(after, was);
		const own = clearFieldValues(after, collection, fieldName);
		return {
			files: [...mirrors.files, ...own.files],
			// reverse order: `own` snapshotted its files AFTER `mirrors` may have written them (a
			// self-relation puts both on the same record), so unwinding forwards would restore stale bytes
			undo: () => { own.undo(); mirrors.undo(); },
			dropped: mirrors.dropped,
			cleared: own.records,
		};
		// ⚠ THE ONE OP THAT MAY LOSE A COMMENT, and the reason the invariant takes an opt-out rather
		// than a heuristic: the comment above a field explains THAT field, so removing the field takes
		// it, and that is the outcome the operator asked for. Every other source write is still held to
		// the count.
	}, { commentsMayDecrease: true });
	return { collection, removed: fieldName, dropped: out.dropped, cleared: out.cleared, staleViews, commits: out.commits };
}

/**
 * The properties object with `fieldName` set, a NEW field landing before the `x-body` one.
 *
 * Property order is form order, and a record's body belongs last — metadata about a record must not
 * render below the record's content. compile already holds that rule for the fields a `templates:`
 * merge contributes (`applyTemplate`); `add-field` did a plain assignment, so the one writer whose
 * output an operator reads back as the form they are about to fill in was also the one that appended
 * after the body.
 *
 * An EXISTING field keeps its place: `update-field` must not silently reorder a descriptor its author
 * ordered by hand. With no body field there is nothing to sit above, so this is a plain append.
 */
function insertBeforeBody(properties, fieldName, prop) {
	const body = bodyField({ schema: { properties } });
	if (body === undefined || properties[fieldName] !== undefined) return { ...properties, [fieldName]: prop };
	const out = {};
	for (const [k, v] of Object.entries(properties)) {
		if (k === body) out[fieldName] = prop;
		out[k] = v;
	}
	return out;
}

function upsertField(ws, store, collection, fieldName, prop, required, verb, target) {
	// Read BEFORE the source is touched. Empty for a field that does not exist yet, so `add-field`
	// shares this path with no branch — it cannot remove a relation it is creating.
	const was = relationsOwnedBy(store, collection, fieldName);
	if (prop == null || typeof prop !== 'object' || Array.isArray(prop)) {
		throw new Error(`field "${fieldName}": prop must be a JSON-Schema object (got ${Array.isArray(prop) ? 'array' : typeof prop}) — nothing was written.`);
	}
	// compile resolves `prop.title` into the COMPILED descriptor, and both writers rebuild a prop
	// from that projection — this one and the studio's field drawer. Without this, retyping any
	// field through the UI writes the DERIVED label back into the source as though a human chose
	// it, and 51 collections fill with `title: Due Date` noise no longer distinguishable from a
	// real override. The webview applies the identical rule in `lib/field-prop.ts`.
	if (prop.title === titleCase(fieldName)) {
		prop = { ...prop };
		delete prop.title;
	}
	// Same rule for the value template. presentation INHERITS a reference's template from its
	// target collection's `title_template`, so a field drawer that round-trips that projection
	// writes the inherited value back onto the field — hand-recreating exactly the 49 duplicated
	// `x-display` lines the inheritance replaced. Only a template that DIFFERS from the target's
	// is a real authored override. For a UNION (`x-reference` a list), presentation inherits only
	// when every member's `title_template` agrees — so the cleanup here computes the same
	// unanimous value, not just the first member's.
	const targets = refTargetsOf(prop) ?? [];
	const tpls = targets === '*' ? [] : targets.map((t) => store.descriptors.get(t)?.title_template);
	const first = tpls[0];
	const inherited = typeof first === 'string' && first.length > 0 && tpls.every((v) => v === first) ? first : undefined;
	if (inherited) {
		if (prop['x-title-template'] === inherited) {
			prop = { ...prop };
			delete prop['x-title-template'];
		}
		if (prop.items?.['x-title-template'] === inherited) {
			prop = { ...prop, items: { ...prop.items } };
			delete prop.items['x-title-template'];
		}
	}
	// Resolved by the CALLER, because only it knows whether a `--module` selector was given and
	// whether creating an overlay is the point (add-field) or a defect (update-field).
	const { file: dest, overlay } = target ?? collectionSourceFile(ws, store, collection, undefined);
	let doc;
	// The BYTES, not just the parse: `dump` cannot round-trip a comment, and a collection descriptor is
	// where a module writes down why the collection exists (see writeSource).
	let previousText = null;
	if (fs.existsSync(dest)) {
		previousText = fs.readFileSync(dest, 'utf8');
		doc = load(previousText);
	} else if (overlay) {
		// Reached only when no source in this workspace declares the base — an npm-shipped or
		// engine-contributed collection. An overlay in the workspace module is the remedy, and
		// compile still requires that module to declare the base's in dreamteamer.dependencies.
		doc = { name: collection, extends: baseModuleRef(ws.root, collection), schema: { properties: {} } };
	} else {
		// The manifest named a base under a module in this workspace, so the file must be there. If
		// it is not, the runtime is describing a source that has been deleted underneath it.
		throw new Error(`${path.relative(ws.root, dest)} is named by the compiled manifest but is not on disk — run \`dreamteamer compile\` and re-run.`);
	}
	// AN IDEMPOTENT WRITE IS A SUCCESS. A command that asks for what is already on disk produced a
	// byte-identical source, and the write gate's `git commit` then failed with "the schema change
	// was rolled back, nothing was changed" — pointing at git for a command that did exactly what
	// was asked. Ten correct spellings reach here (a re-run, `--inverse=` on a mirror-less field,
	// `--unique false` on a non-unique FK, `--type` restated…), so an "apply my schema" script broke
	// on every already-satisfied field, as did any retry after a partial failure. `renameCollection`
	// set the precedent: say so plainly and stop, without a commit.
	const already = doc.schema?.properties?.[fieldName];
	const wasRequired = Array.isArray(doc.schema?.required) && doc.schema.required.includes(fieldName);
	const willBeRequired = required === undefined ? wasRequired : required === true;
	if (already !== undefined && wasRequired === willBeRequired && canonical(already) === canonical(prop)) {
		// ⚠ STILL A GATE. These verbs write sources THROUGH a compile, and before the shortcut above
		// existed even a no-op went through `writeGated` and so hard-failed on a pre-existing compile
		// error ANYWHERE in the tree. Returning early bypassed that: a no-op reported "already exactly
		// that" against a workspace that did not compile, and the only remaining signal was the
		// non-blocking "`.dreamteamer` is stale" warning. So the same compile runs here — nothing is
		// written and nothing is committed, but a broken workspace fails exactly as the gate fails it.
		compileGated(ws, store);
		return { collection, field: fieldName, file: dest, extends: doc.extends, prop: already, unchanged: true };
	}
	const gate = writeGated(ws, store, [dest], `dreamteamer: ${collection} ${verb}`, () => {
		doc.schema ??= { properties: {} };
		doc.schema.properties ??= {};
		doc.schema.properties = insertBeforeBody(doc.schema.properties, fieldName, prop);
		if (required === true) doc.schema.required = [...new Set([...(doc.schema.required ?? []), fieldName])];
		if (required === false && Array.isArray(doc.schema.required)) doc.schema.required = doc.schema.required.filter((r) => r !== fieldName);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, writeSource(previousText, doc));
	}, () => dropOrphanedMirrors(new Store(ws), was));
	const { dropped, commits } = gate;
	// the prop as WRITTEN — callers report the relation off this, never off the one they passed:
	// both this function and updateField reassign it, so a caller's own copy can be a stale object.
	return { collection, field: fieldName, file: dest, extends: doc.extends, prop, dropped, commits };
}

/**
 * WHERE A UI-VIEW'S SOURCE ACTUALLY LIVES — asked of the manifest, exactly as `descriptorSourceDir`
 * asks it for a collection, and for the same reason: the guard that matters is "will `npm install`
 * erase this write", not "which module owns it".
 *
 * ⚠ This used to be `workspaceSystemDir` unconditionally, which silently meant a view could only be
 * saved if the WORKSPACE MODULE happened to ship it. Saving one shipped by any other inline module
 * wrote a SECOND file carrying the same id, and compile refuses that by name — so the whole write
 * rolled back and the surface reported `name collision on ui-view "…"` instead of saving. Measured
 * on a three-module workspace: every one of the views shipped by a module OTHER than the workspace
 * module was unsaveable, and the failure said nothing about why.
 *
 * Returns `{ file, shipped }` — where to write, and the workspace-relative source that already
 * exists (null for a new view, which lands in the workspace module as before).
 */
function uiViewSourceFile(ws, id) {
	const src = readManifest(ws.root)?.entries?.[`ui-views/${id}.ui-view.yaml`]?.sources?.[0];
	// sources are `{path, hash}`; tolerate the pre-0.10 string form, same as compile's staleness check
	const shipped = typeof src === 'string' ? src : src?.path;
	if (!shipped) return { file: path.join(workspaceSystemDir(ws, 'ui-views'), `${id}.ui-view.yaml`), shipped: null };
	return { file: path.join(ws.root, shipped), shipped };
}

// saved views (M3): a studio-saved view IS a ui-view record — but ui-views are
// system-stored (sources + compile), so the write goes through the same gate as any
// other schema op. the studio "save view" button lands here.
export function saveUiView(ws, store, { id, view }) {
	if (!id || !/^[a-z0-9][a-z0-9-/]*$/.test(id)) throw new Error(`invalid ui-view id "${id}" — lowercase slug required`);
	const { file: dest, shipped } = uiViewSourceFile(ws, id);
	if (shipped && /(^|\/)node_modules\//.test(shipped))
		throw new Error(`ui-view "${id}" is shipped by an installed package (${shipped}) — a write there is erased by the next npm install.\n  save it under a different name, or disable it (dreamteamer.disable) and re-create it.`);
	const existed = fs.existsSync(dest);
	// A module source is where this project writes down WHY a view exists; `dump` cannot keep that.
	const previous = existed ? fs.readFileSync(dest, 'utf8') : null;
	// ⚠ opted OUT of the comment invariant, on the same rule `remove-field` is: this write REPLACES
	// the view, so a key the caller omits is deliberately gone (see the `filter:` case) and the comment
	// explaining that key goes with it. Every key that SURVIVES keeps its comments, which is what the
	// round-trip buys and what the old `dump` could not do.
	const gate = writeGated(ws, store, [dest], `dreamteamer: ui-views ${existed ? 'update' : 'add'} ${id}`, () => {
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, writeSource(previous, view));
	}, undefined, { commentsMayDecrease: true });
	return { id, file: dest, updated: existed, commits: gate.commits };
}

export function removeUiView(ws, store, id) {
	// Same source resolution as the save above — an inline module's view is under this repo's git
	// history like everything else, so deleting it is one revertable commit. Refusing it while
	// ALLOWING a save to the same file would be an asymmetry with nothing behind it.
	const { file: dest, shipped } = uiViewSourceFile(ws, id);
	if (shipped && /(^|\/)node_modules\//.test(shipped))
		throw new Error(`ui-view "${id}" is shipped by an installed package (${shipped}) — removing the file would be undone by the next npm install.\n  disable it instead: add "<module>/${id}" to dreamteamer.disable in package.json.`);
	if (!fs.existsSync(dest)) throw new Error(`ui-view "${id}" does not exist`);
	const gate = writeGated(ws, store, [dest], `dreamteamer: ui-views rm ${id}`, () => fs.rmSync(dest), undefined, { commentsMayDecrease: true });
	return { removed: id, commits: gate.commits };
}

// base module for an extends pointer — resolved via manifest.modules across ALL channels
// (audit open finding 1: the old regex only understood inline modules/… paths)
function baseModuleRef(root, collection) {
	const manifest = readManifest(root) ?? {};
	// entry keys are runtime-relative and lost their `system/` prefix in the flatten; a manifest
	// written by an older engine still carries it, and this reads whatever is on disk
	const entry = manifest.entries?.[`collections/${collection}.collection.yaml`]
		?? manifest.entries?.[`system/collections/${collection}.collection.yaml`];
	const src = entry?.sources?.[0];
	const srcPath = typeof src === 'string' ? src : src?.path;
	if (!srcPath) throw new Error(`cannot determine the base module for "${collection}"`);
	for (const m of manifest.modules ?? []) {
		const modRoot = m.root === '.' ? '' : `${m.root}/`;
		if (modRoot && srcPath.startsWith(modRoot)) return `${m.name}/${collection}`;
	}
	throw new Error(`cannot determine the base module for "${collection}" — its source is ${srcPath}; edit that descriptor directly`);
}

// CLI/API type sugar → JSON Schema property.
//
// `collection` is the collection the field is being added TO — only `--inverse` with no value needs
// it (the derived mirror name is a function of both sides), so it defaults and every existing
// two-argument caller keeps working.
export function fieldDef(store, flags, collection) {
	flags = impliedByMirrorOf(store, flags);
	const t = flags.type ?? 'string';
	const def = flags['default-value'] ?? flags.default;
	const p = (() => {
		// ⚠ A COLLECTION NAME ALWAYS MEANS A REFERENCE, and that is asked FIRST — above the sugar,
		// not below it in the `default:` arm where it used to sit. A workspace that ships a collection
		// called `tags` is the ordinary case (it is a noun a vault keeps records of), and there
		// `--type tags` hit the sugar and wrote a plain array of strings: the collection was
		// unreferenceable, every relation flag on the field was then refused for naming no reference,
		// and neither half mentioned the collision. Same shape for one named `enum`, `date` or `text`.
		// The sugar is a convenience; the workspace's own nouns outrank it.
		//
		// ⚠ Only a STATED type, never the `'string'` default. With no `--type` that value is the
		// default of a function that was told nothing (see updateField's carry) — resolving it would
		// turn every description-only `update-field` in a workspace with a collection literally named
		// `string` into a silent retype to a reference, which is the exact class of bug that carry exists
		// to close.
		if (flags.type !== undefined && store.descriptors.has(t)) return { type: 'string', 'x-reference': t };
		switch (t) {
			case 'string': case 'text': return { type: 'string' };
			case 'markdown': return { type: 'string', format: 'markdown' };
			case 'boolean': return { type: 'boolean' };
			case 'number': return { type: 'number' };
			case 'integer': return { type: 'integer' };
			case 'date': return { type: 'string', format: 'date' };
			// `timestamp` is the WIRE type presentation.js projects `date-time` to, and therefore what
			// the studio's field drawer round-trips. Accepting it here means the vocabulary you read
			// out of `presentation` is the vocabulary you can type back into the CLI.
			case 'datetime': case 'timestamp': return { type: 'string', format: 'date-time' };
			case 'enum': {
				if (!flags.options) throw new Error('enum needs options "a,b,c"');
				return { type: 'string', enum: optionList(flags.options) };
			}
			case 'tags': return { type: 'array', items: { type: 'string' } };
			default:
				if (t === 'reference') return { type: 'string', 'x-reference': flags.target ?? '*' };
				throw new Error(`unknown field type "${t}"`);
		}
	})();
	if (def !== undefined) p.default = coerceDefault(p.type, def);
	// what the field MEANS, in one line — JSON Schema's own keyword, projected to every surface by
	// presentation.js. A field whose name doesn't say enough is documented here, not in a comment.
	if (typeof flags.description === 'string' && flags.description.length > 0) p.description = flags.description;
	// `--body` marks the ONE field a `codec: md` record's prose lands in — the text after the
	// frontmatter. It exists because compile refuses to stamp a relation mirror onto a collection that
	// declares no `x-body` and told the author to declare one, which no verb could do: the remedy the
	// refusal named was reachable only by hand-editing a descriptor these verbs own. compile refuses a
	// SECOND body, so the "only one" rule lives in one place rather than here as well.
	if (isOn(flags.body)) {
		if (p.type !== 'string') throw new Error(`--body marks the field a record's PROSE lands in, so it has to be text — try --type markdown (got ${flags.type ?? 'string'}).`);
		p['x-body'] = true;
	}

	// ---- relations ----------------------------------------------------------------------------
	// ⚠ EVERY relation flag is skipped when the flags name no reference, because on `update-field`
	// with no `--type` the target has not arrived yet — it is carried from the previous prop, after
	// this. updateField applies them once it has one; metaAddField, which has nothing to carry,
	// refuses instead. Applying them here would also put them on the WRONG node: updateField may
	// rebuild the prop as an array, and the keywords belong on `items`.
	//
	// `--many` is a CARDINALITY flag, not a type: `--type meetings --many` is an array of references
	// to meetings. The reference keyword moves onto `items`, which is the node every relation
	// consumer (relations.js, check, the store, presentation) reads it from.
	if (isOn(flags.many) && p['x-reference'] !== undefined) {
		const ref = p['x-reference'];
		delete p['x-reference'];
		delete p.format;
		p.type = 'array';
		p.items = { type: 'string', 'x-reference': ref };
	}
	const holder = p.items ?? p;
	if (holder['x-reference'] !== undefined) applyRelationFlags(holder, flags, collection, store.namespaces ?? []);
	return p;
}

/**
 * `--mirror-of <owner>.<field>` IMPLIES the type, because it names the far side of a relation that
 * already exists and that side says everything about this field's shape: it holds references to the
 * OWNING collection, as an array unless the owner's foreign key is one-to-one — a unique FK can be
 * claimed by one record, so its mirror is a single reference.
 *
 * Without this, the spec's own worked command was refused for not restating what it had just said:
 *
 *   dt schema add-field meetings --name recordings --mirror-of recordings.meeting
 *   ✖ --mirror-of needs a --type <collection> reference.
 *
 * …and restating it was a chance to DISAGREE, which is worse than the refusal: compile derives the
 * owner's cardinality FROM the authored mirror's shape (`foldMirrorSide`), so a hand-typed `--many`
 * on the mirror of a unique FK is a contradiction compile has to reject on the far side of the write.
 * So an explicit `--type` that names a different collection is an error here rather than a silent
 * loser. `--many` stays available for the case this cannot see: a relation whose owning field does
 * not declare x-unique yet.
 */
function impliedByMirrorOf(store, flags) {
	const of = typeof flags['mirror-of'] === 'string' && flags['mirror-of'].length > 0 ? flags['mirror-of'] : null;
	if (!of) return flags;
	const dot = of.lastIndexOf('.'); // a collection name may contain '/', so split at the LAST dot
	if (dot < 1) throw new Error(`--mirror-of takes <collection>.<field> — got "${of}".`);
	const owner = of.slice(0, dot), ownerField = of.slice(dot + 1);
	if (!store.descriptors.has(owner)) throw new Error(`--mirror-of ${of}: there is no collection "${owner}".`);
	if (flags.type !== undefined && flags.type !== owner) {
		throw new Error(`--mirror-of ${of} makes this field a mirror of ${owner}, so --type ${flags.type} contradicts it — drop --type, it is implied.`);
	}
	const prop = store.descriptor(owner).schema?.properties?.[ownerField];
	const holder = (prop?.items && typeof prop.items === 'object') ? prop.items : prop;
	const many = holder?.['x-unique'] === true ? flags.many : (flags.many ?? true);
	return { ...flags, type: owner, many };
}

/** A CLI default arrives as a string, and which JSON type it becomes depends on the field's. Shared
 *  by `fieldDef` and by updateField's carry, because `--default-value 7` with no `--type` has to be
 *  coerced against the type the field ALREADY has: keying it off `fieldDef`'s `{type: string}` default
 *  wrote the string "7" into a number field, which then reads back as a string on every new record. */
const coerceDefault = (type, def) => (type === 'boolean'
	? def === 'true' || def === true
	: type === 'number' || type === 'integer' ? Number(def) : def);

/** `--options a,b,c` → the enum's values. Shared by `fieldDef` (which needs `--type enum` to build
 *  one from nothing) and by updateField's carry (where `--options` alone restates the values of an
 *  enum that already exists) — one splitter, so the two spellings cannot disagree about whitespace. */
const optionList = (v) => (Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim()).filter(Boolean);

/** Deep value equality as a string, key ORDER ignored — a prop read back out of YAML comes in
 *  authored order and a rebuilt one comes in flag order, and "is this already exactly that field"
 *  must not turn on the difference. */
function canonical(v) {
	if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
	if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
	return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

/** Was a boolean-ish flag turned ON? `--unique`, `--unique true` and `--unique=true` are one act —
 *  `--required true` is this CLI's documented spelling, so the long form is what a user types. ⚠ Not
 *  the same question as whether the flag was STATED (`statedKeywords`): `--unique false` is stated
 *  and off, which CLEARS the keyword rather than carrying the previous value forward. The two
 *  questions disagreeing is what silently turned a one-to-one into a many-to-one. */
const isOn = (v) => v === true || v === 'true';

/**
 * The relation flags, applied to the node that CARRIES the reference. Called from `fieldDef` for
 * add-field and again from `updateField` once the carry-forward has supplied a target, so both
 * entry points reach one implementation and cannot drift.
 */
function applyRelationFlags(holder, flags, collection, namespaces) {
	if (isOn(flags.unique)) holder['x-unique'] = true;
	if (flags['on-delete'] !== undefined) {
		// A bare `--on-delete` (no value) parses as `true`, which would otherwise write nothing while
		// counting as stated — i.e. silently clear an authored policy.
		if (flags['on-delete'] !== 'restrict' && flags['on-delete'] !== 'set-null') throw new Error('--on-delete takes restrict or set-null.');
		holder['x-on-delete'] = flags['on-delete'];
	}
	// Spelling B: the mirror declared from the side that WANTS it. There is no wrong side, so both
	// flags exist and compile normalizes them to the same compiled pair.
	if (typeof flags['mirror-of'] === 'string' && flags['mirror-of'].length > 0) holder['x-inverse-of'] = flags['mirror-of'];
	// `--inverse` with no value derives the name; `--inverse=` is the empty string, which is the
	// explicit "no mirror" — stated, so nothing is carried, and nothing is written.
	if (flags.inverse !== undefined && flags.inverse !== '') {
		const target = holder['x-reference'];
		if (typeof target !== 'string' || target === '*') throw new Error('--inverse needs a single-collection --type <collection> reference.');
		// the CARRIED x-unique counts, not just the flag: a bare --inverse on an existing unique FK
		// still derives the singular mirror name
		holder['x-inverse'] = typeof flags.inverse === 'string'
			? flags.inverse
			: defaultInverseName(holder['x-unique'] === true, target, collection, namespaces);
	}
}

/** The first relation flag a caller stated, or undefined — for refusing them on a field that
 *  references nothing, where every one of them would be written as a dead keyword. */
export function relationFlagsStated(flags) {
	return ['inverse', 'unique', 'on-delete', 'mirror-of', 'many'].find((f) => flags[f] !== undefined);
}

/**
 * The mirror name a bare `--inverse` derives: the OWNING collection's own name, with the target's
 * singular prefix stripped — `meeting-recordings` pointing at `meetings` mirrors as `recordings`,
 * not `meeting-recordings`, because on a meeting the prefix is already implied. Singularized when
 * the FK is unique, so a one-to-one mirror reads as the single record it holds (`meetings.summary`).
 *
 * Namespace-safe: the derivation is about the BARE names, and a mirror field name can never carry a
 * namespace anyway.
 */
function defaultInverseName(unique, target, owner, namespaces) {
	if (!owner) throw new Error('--inverse with no name needs the owning collection — pass one explicitly.');
	const base = baseNameOf(owner, namespaces);
	const targetBase = baseNameOf(target, namespaces);
	// A self-reference would derive its own name, which collides with the field it mirrors.
	if (base === targetBase) throw new Error('--inverse on a self-reference has no derivable name — pass one explicitly.');
	const prefix = `${singular(targetBase)}-`;
	const stripped = base.startsWith(prefix) ? base.slice(prefix.length) : base;
	return unique ? singular(stripped) : stripped;
}

