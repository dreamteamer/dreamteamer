// schema operations — source-writing mutations shared by the CLI meta verbs and the
// server's schema endpoints. the contract (audit finding 11, clean-room bug 2): an op
// writes sources, proves them with a REAL compile, and only then commits — an
// uncompilable source can never land in history. the successful gate compile also
// leaves the runtime fresh, which kills the add-field-right-after-collections-add
// papercut (review finding 7): schema ops ARE explicit compiles.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { load, dump, writeSource, renameKeys, commentCount } from './yaml.js';
import { compile, kindDir, KINDS, repoRootOf } from './compile.js';
import { readManifest, loadDescriptors } from './runtime.js';
import { normalizeNamespaces, namespaceOf, baseNameOf, qualify, defaultStoragePath, singular } from './namespace.js';
import { fieldsOf, targetsOf, storageOf, isRuntime, bodyFieldOf, moduleOf } from './descriptor.js';
import { SCALAR_TYPES, enumValues } from './fields.js';
import { FIELD_OPTIONS, TEMPLATE_OPTIONS } from './views.js';

// Same rule as store.js: a git failure we CATCH must not also print git's own error on top of the
// clean message we throw. stdout stays piped because some callers read it.
const GIT_QUIET = ['ignore', 'pipe', 'ignore'];
import { walk, idFromRecordPath, parseRecord, EXT } from './records.js';
import { Store, serialize, atomicWrite } from './store.js';

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
 * ⚠ THE OPT-OUT IS REAL AND NARROW. `rm-field` takes the comment ABOVE the field with the field,
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
			const dep = /an overlay of "[^"]+", but module "([^"]+)" neither depends on "([^"]+)"/.exec(e.message);
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
		// ⚠ A WRITE THAT CHANGED NO BYTES MUST NOT REACH `git commit`. `git commit` on an empty index
		// exits NON-ZERO, so the catch below read a successful no-op as a failed op and reported
		// `✖ git commit failed — the schema change was rolled back` with the raw git command appended,
		// at exit 1 — for `dt set collections/people description=<the value it already has>`, which
		// asked for nothing and got nothing. Every sibling verb already has the graceful spelling
		// ("already named that, nothing to do"), and the documented namespace cleanup path
		// (`dt set modules/<m> namespaces=<ns>` where it is already declared) ran straight into it.
		//
		// Compared as BYTES, after the gate compile: an op whose mutation is a re-serialization can
		// produce an identical file, and "identical" is the only definition of no-op the caller can
		// act on.
		const moved = snapshots.some(({ f, prev }) => {
			const now = fs.existsSync(f) ? fs.readFileSync(f) : null;
			return now === null ? prev !== null : prev === null || !now.equals(prev);
		});
		if (!moved && !extra.files.length) return { ...extra, commits: [], unchanged: true };
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
// A module is THREE-SPELLED today: the package `name` (discovery, `dependencies`), the
// folder (the `workspace_module` key), and the slugged scope-stripped record id. The RECORD ID is
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

/** id → the package `name` its sources actually spell, which is what `dependencies` and `disable`
 *  are written in. Equal to the id for anything `add modules` created. */
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
 *  `workspace_module` and did not do this compiled the PREVIOUS layout and failed on a stray-sources
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

export function createModule(ws, store, { name, description, namespace }) {
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
	// §6.2: `--namespace hr` DECLARES THE NAMESPACE IN THE MODULE, which is the whole point of §8 —
	// the workspace's effective set is the union of what its modules declare, so a module that owns a
	// namespace can be copied alone into a bare workspace and still compile.
	//
	// ⚠ It used to be dropped on the floor. `dt add modules --name hr --namespace hr` reported ✔,
	// shipped `"dreamteamer": {}`, left the manifest's `namespaces: []`, and the next
	// `add collections --module hr` then created an UNPREFIXED collection — four steps of silence
	// behind one accepted-and-ignored flag. Normalized here rather than trusted: a leading or
	// trailing slash in a declaration re-splits every reference under it.
	const ns = typeof namespace === 'string' ? namespace.replace(/^\/+|\/+$/g, '') : '';
	if (ns) {
		const owner = moduleRows(store).find((r) => normalizeNamespaces(r.fields.namespaces).includes(ns));
		// compile refuses two declarations of one namespace, and refusing it HERE names the verb that
		// fixes it instead of rolling a created module back over a compile error.
		if (owner) throw new Error(`namespace "${ns}" is already declared by ${owner.id} — one owner. Remove it there first (dt set modules/${owner.id} namespaces=…), or pick another namespace.`);
		dt.namespaces = [ns];
	}
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
	return { id: name, root: path.relative(ws.root, root), file: pkgFile, namespace: ns || null, commits: out.commits };
}

/** The settable fields of a `modules` record, and how each translates from the record-shaped value
 *  the operator types to the form the source file uses. */
const MODULE_SETTABLE = {
	description: { key: 'description', from: (v) => String(v) },
	dependencies: { key: 'dependencies', from: (v, store) => asList(v).map((r) => moduleIdFromRef(r, store)) },
	// the collections a module references but does not own — names, never references, in the source
	peer_collections: { key: 'peer_collections', from: (v) => asList(v).map((r) => String(r).replace(/^collections\//, '')) },
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
	return { id, file, changed, commits: gate.commits, unchanged: gate.unchanged };
}

export function removeModule(ws, store, id, { force = false, dryRun = false } = {}) {
	const { fields } = moduleRecord(store, id);
	if (fields.location === 'node_modules') {
		throw new Error(`module "${id}" is installed by npm (${fields.path}) — remove it from package.json dependencies and run \`npm install\`; a delete under node_modules/ is erased by the next install.`);
	}
	if (fields.location === 'git_modules') {
		throw new Error(`module "${id}" is a clone under ${fields.path}, and its package.json lives in ANOTHER repo — remove it from dreamteamer.git_modules and delete the clone. This verb removes inline modules only.`);
	}
	if (ws.pkg.dreamteamer?.workspace_module === id) {
		throw new Error(`module "${id}" IS this workspace's own module (dreamteamer.workspace_module) — removing it would leave the workspace with no sources of its own. Point workspace_module at another module first.`);
	}
	if (fields.owns_data === true) {
		throw new Error(`module "${id}" sets owns_data, so its records live INSIDE ${fields.path}/data — removing the module would delete them, which this verb never does. Drop owns_data and move the records out first.`);
	}

	const shipped = (fields.collections ?? []).map((r) => String(r).replace(/^collections\//, '')).sort();
	const withRecords = shipped.filter((c) => store.descriptors.has(c) && store.ids(c).size > 0);
	// A `dependencies` entry naming this module in ANOTHER module fails the gate compile ("depends
	// on X, which is not installed"), so it goes in the SAME write — otherwise --force is a verb that
	// cannot succeed. peer_collections names COLLECTIONS and needs no edit: a peer whose provider is
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
	// ⚠ THE DRY RUN COMES FIRST, BEFORE THE --force REFUSAL. A dry run writes nothing, so refusing
	// it for the want of a flag is pure friction — and it is the WRONG WAY ROUND: the plan is what
	// the operator reads to decide whether `--force` is a thing they want to type.
	if (dryRun) return { ...plan, dryRun: true };
	if (shipped.length && !force) {
		throw new Error(`${id} still ships ${shipped.length} collection${shipped.length === 1 ? '' : 's'} (${shipped.join(', ')}), ${withRecords.length} with records. --force removes the sources; records stay and become unindexed.`);
	}

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
	if (fields.location === 'node_modules') {
		throw new Error(`module "${oldId}" ships from node_modules (${fields.path}) — a write there is erased by the next \`npm install\`. Rename it in its own repo and release.`);
	}
	if (fields.location === 'git_modules') {
		// ⚠ TWO COMMITS BY CONSTRUCTION, and the verb says so rather than half-doing it: the module's
		// package.json lives in the clone's own repo, and this workspace's half (git_modules,
		// dependencies, modules/<id> refs) is a commit here. Perform the workspace half only after the
		// clone half has landed and been pushed.
		throw new Error(`module "${oldId}" is a clone under ${fields.path}, whose package.json is in ANOTHER repo — a git-shape rename is TWO commits by construction.\n  1. rename it there (package.json name → "${newId}") and push;\n  2. re-run this to perform the workspace half: dreamteamer.git_modules, every dependencies entry, and modules/${oldId} references.`);
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

			// 3. the WORKSPACE package.json: `workspace_module` when it names this module. `disable`
			//    needs nothing: a `<kind>/<id>` entry names an entity, never its module, and a module a
			//    `modules/<id>` entry drops is never discovered, so it cannot be the one renamed here.
			//    SNAPSHOTTED FIRST — editWorkspacePkg writes, so capturing the pre-image afterwards is
			//    impossible.
			snap(path.join(ws.root, 'package.json'));
			const wsFile = editWorkspacePkg(ws, (dt) => {
				if (dt.workspace_module === oldId) dt.workspace_module = newId;
			});
			paths.add(path.relative(ws.root, wsFile));

			// 4. every OTHER module's `dreamteamer.dependencies` naming it. peer_collections names
			//    collections and is untouched.
			for (const r of moduleRows(store)) {
				if (r.id === oldId || r.fields.location === 'node_modules') continue;
				const f = path.join(ws.root, r.fields.path, 'package.json');
				if (!fs.existsSync(f)) continue;
				const dt = JSON.parse(fs.readFileSync(f, 'utf8')).dreamteamer ?? {};
				if (!(dt.dependencies ?? []).includes(oldPkgName)) continue;
				snap(f);
				editModulePkg(f, (d) => { d.dependencies = d.dependencies.map((n) => (n === oldPkgName ? newId : n)); });
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
 * The reference contract says every collection a field references is owned by the
 * referencing module, declared in its `dependencies`, or named in its `peer_collections`. Moving a
 * collection changes who owns it, so it can break the contract in two directions at once: this
 * collection's own outbound refs, and every inbound ref pointing at it.
 *
 * ⚠ AND THE FIX CAN BE WORSE THAN THE BREAK. `dependencies` must be acyclic, so "add A to B's
 * dependencies" is only a fix when B does not already sit upstream of A — otherwise it is a ring,
 * and the honest answer is `peer_collections` (which names a COLLECTION and therefore cannot cycle)
 * or moving the other collection too. Naming the ring is the difference between a refusal an
 * operator can act on and one they have to re-derive.
 *
 * Reads the compiled projections through the Store rather than re-running discovery: `modules`
 * records carry `dependencies`, each compiled descriptor carries its `module`, and the manifest is
 * what actually compiled.
 */
function moveImpact(store, name, toModule) {
	const mods = moduleRows(store);
	const depsOf = new Map(mods.map((m) => [m.id, (m.fields.dependencies ?? []).map((r) => String(r).replace(/^modules\//, ''))]));
	// the module RECORD's `peer_collections`, projected from package.json under the same name
	const peersOf = new Map(mods.map((m) => [m.id, (m.fields.peer_collections ?? []).map((r) => String(r).replace(/^collections\//, ''))]));
	const ownerOf = new Map();
	for (const [id, d] of store.descriptors) ownerOf.set(id, moduleOf(d));
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
		if (isRuntime(store.descriptors.get(target)) || target === 'repos') return;
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

/** Every collection a field of this descriptor references — a scalar or a union, on a top-level
 *  field or inside an object's `fields`. `reference` (any record) names no collection, so it is
 *  skipped: it is exempt from the reference contract by construction. */
function outboundTargets(d) {
	const out = new Set();
	const walkFields = (fields) => {
		for (const f of Object.values(fields ?? {})) {
			const t = targetsOf(f);
			if (Array.isArray(t)) for (const x of t) out.add(x);
			if (f?.fields) walkFields(f.fields);
		}
	};
	walkFields(fieldsOf(d));
	return out;
}

export function moveCollection(ws, store, name, toModule, { dryRun = false } = {}) {
	const d = store.descriptor(name); // throws with the known-collection list
	if (isRuntime(d)) {
		throw new Error(`"${name}" is a compiled source, not a data collection — it has no module to move it to.`);
	}
	const to = moduleRecord(store, toModule); // throws with the known-module list
	const from = moduleOf(d);
	if (from === toModule) return { moved: false, name, from, to: toModule };
	if (IN_NODE_MODULES(to.fields.path)) {
		throw new Error(`module "${toModule}" ships from node_modules (${to.fields.path}) — a write there is erased by the next \`npm install\`. Vendor it into modules/ first.`);
	}
	const { base } = baseDescriptorSource(ws, name);
	if (!base) throw new Error(`"${name}" has no writable descriptor source in this workspace — the manifest names none under a module here.`);
	if (IN_NODE_MODULES(base)) {
		throw new Error(`"${name}" ships from node_modules (${base}) — a write there is erased by the next \`npm install\`. Add fields from your own module instead, which writes an overlay: dreamteamer add-field ${name} --module <your-module> …`);
	}

	// ---- the reference contract, BEFORE anything moves ------------------------------------------
	const needs = moveImpact(store, name, toModule);
	const plan = {
		name, from, to: toModule, needs,
		records: store.ids(name).size,
		refs: 0,
		// an overlay names the collection, never the module that owns it, so a move rewrites the base alone
		descriptors: 1,
		cleared: 0,
	};
	if (needs.length) {
		const lines = needs.map((n) => {
			const fix = n.ring
				? `${n.referrer} → ${n.owner} would be a ring (${n.owner} already reaches ${n.referrer}). Add ${n.target} to ${n.referrer}'s peer_collections (dt set modules/${n.referrer} peer_collections=collections/${n.target}), or move ${n.target} as well.`
				: `add it: dt set modules/${n.referrer} dependencies=modules/${n.owner} — or dt set modules/${n.referrer} peer_collections=collections/${n.target} if ${n.referrer} should work without it.`;
			return `  ${n.referrer} references ${n.target}, owned by ${n.owner} after the move. ${fix}`;
		});
		throw new Error(`move rolled back. ${name} → ${toModule} breaks the reference contract:\n${lines.join('\n')}`);
	}
	if (dryRun) return { ...plan, moved: false, dryRun: true };

	const dest = path.join(kindDir(path.join(ws.root, to.fields.path), 'collections'), `${name}.collection.yaml`);
	if (fs.existsSync(dest)) throw new Error(`${path.relative(ws.root, dest)} already exists — move or remove it first; nothing was moved`);
	const src = path.join(ws.root, base);
	const fromRow = moduleRows(store).find((m) => m.id === from);
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
 * The collection-level keys `dt set collections/<c>` writes, each by its v2 path, and how each
 * parses. A dotted key is a position inside a block (`display.nav.icon=pulse`). With
 * `display.nav.order` settable, `dt move collections/<c> --after <c>` means nav ordering and nothing
 * else.
 *
 * ⚠ `name` is deliberately absent, and so are `fields`, `storage` and `ids`. Renaming a
 * collection moves its descriptor, its records, their filenames and every inbound reference in one
 * commit — that is `rename collections/<old> <new>`, and offering `name=` here would be a second
 * spelling for it that does one of those five things. Fields have verbs of their own.
 */
const text = (v) => String(v);
const bool = (k) => (v) => {
	if (v === true || v === 'true') return true;
	if (v === false || v === 'false') return false;
	// a privacy or visibility switch that coerces "yes" to false is the wrong kind of forgiving
	throw new Error(`${k} takes true or false — got "${v}"`);
};
const nameList = (v) => (Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim()).filter(Boolean);
const COLLECTION_SETTABLE = {
	description: text,
	use_when: text,
	title: text,
	singular: text, // the word the CLI accepts beside the name; compile refuses a collision
	record_title: text,
	// `sensitive=true` withholds the WHOLE collection from every export
	sensitive: bool('sensitive'),
	// `internal=true` takes the collection out of the domain listing and onto a surface's schema
	// surface; where its records live and whether they can be written are unchanged
	internal: bool('internal'),
	'display.nav.icon': text,
	'display.nav.order': (v) => {
		const n = Number(v);
		if (!Number.isFinite(n)) throw new Error(`display.nav.order takes a number — got "${v}"`);
		return n;
	},
	'display.nav.section': text,
	'display.list.columns': nameList,
	'display.list.sort': text,
};

/** "people has no field X" / "people has no fields X, Y" — the plural without a second sentence. */
const collectionMissingFields = (name, missing) => `${name} has no field${missing.length === 1 ? '' : 's'} ${missing.join(', ')}`;

/** Set a dotted path in a plain object, creating the blocks on the way. */
function setPath(obj, dotted, value) {
	const keys = dotted.split('.');
	let at = obj;
	for (const k of keys.slice(0, -1)) {
		if (!at[k] || typeof at[k] !== 'object' || Array.isArray(at[k])) at[k] = {};
		at = at[k];
	}
	at[keys[keys.length - 1]] = value;
}

/** Delete a dotted path, and every block the deletion leaves empty — an empty `display.nav` is a
 *  statement nobody made. */
function deletePath(obj, dotted) {
	const keys = dotted.split('.');
	const trail = [obj];
	for (const k of keys.slice(0, -1)) {
		const next = trail[trail.length - 1]?.[k];
		if (!next || typeof next !== 'object') return;
		trail.push(next);
	}
	delete trail[trail.length - 1][keys[keys.length - 1]];
	for (let i = trail.length - 1; i > 0; i--) {
		if (Object.keys(trail[i]).length) break;
		delete trail[i - 1][keys[i - 1]];
	}
}

export function setCollectionScalars(ws, store, name, changes, { moduleId } = {}) {
	const d = store.descriptor(name);
	const unknown = Object.keys(changes).filter((k) => !(k in COLLECTION_SETTABLE));
	if (unknown.length) {
		const k = unknown[0];
		const extra = k === 'name' ? ` — a collection is renamed with its records and every inbound reference in one commit: dreamteamer rename collections/${name} <new-name>` : '';
		throw new Error(`"${k}" is not a settable key of a collection${extra}. Settable: ${Object.keys(COLLECTION_SETTABLE).join(', ')}, plus module= (which MOVES it). A field is written with dreamteamer add-field/set-field ${name}.`);
	}
	// The columns and the sort name fields of THIS collection. compile refuses a dangling one too;
	// refusing here names the verb that declares the field instead of rolling a write back.
	const known = fieldsOf(d);
	for (const key of ['display.list.columns', 'display.list.sort']) {
		if (!(key in changes) || changes[key] === '' || changes[key] === null) continue; // a clear has nothing to validate
		const named = key === 'display.list.sort' ? [String(changes[key]).replace(/^-/, '')] : nameList(changes[key]);
		const missing = named.filter((f) => f && !known[f]);
		if (missing.length) {
			throw new Error(`${key}: ${collectionMissingFields(name, missing)} — declare it first (dreamteamer add-field ${name} --name ${missing[0]} --type <t>).`);
		}
	}
	// ⚠ NAMED, not resolved to an overlay. `collectionSourceFile` falls back to a workspace-module
	// path for a base it cannot write, which is right for `add-field` (an overlay IS the remedy) and
	// wrong here: a collection-level key belongs to the base, and an overlay that set it would
	// silently win over the owner's choice.
	const owned = baseDescriptorSource(ws, name).base;
	if (owned && IN_NODE_MODULES(owned)) {
		throw new Error(`"${name}" ships from node_modules (${owned}) — a write there is erased by the next \`npm install\`, and a collection-level key belongs to the module that owns it. Add "collections/${name}" to dreamteamer.disable and declare your own instead.`);
	}
	const { file } = collectionSourceFile(ws, store, name, moduleId, { subject: name });
	if (!fs.existsSync(file)) throw new Error(`${path.relative(ws.root, file)} is not on disk — run \`dreamteamer compile\` and re-run.`);
	const previousText = fs.readFileSync(file, 'utf8');
	const doc = load(previousText);
	const changed = [];
	const gate = writeGated(ws, store, [file], `dreamteamer: collections set ${name} ${Object.keys(changes).join(' ')}`, () => {
		for (const [k, raw] of Object.entries(changes)) {
			// An empty value REMOVES the key — `store.set`'s convention, extended to the descriptor.
			if (raw === '' || raw === null) deletePath(doc, k);
			else setPath(doc, k, COLLECTION_SETTABLE[k](raw));
			changed.push(k);
		}
		fs.writeFileSync(file, writeSource(previousText, doc));
	});
	return { name, file, changed, commits: gate.commits, unchanged: gate.unchanged };
}

// ---- the positions that name a field, and a value ----------------------------------------------
// A field is referenced BY NAME, not as a `<collection>/<id>` reference, so `store.rewriteRefs` can
// see none of it. Rule 6 is the list of every position a descriptor, a view or a binding may name a
// field in — compile validates each one — and these walkers visit exactly that list:
//
//   the collection's own sources (its base and every overlay):
//     `fields.<f>` · a field's `display.unit_field` · `storage.under.parent` · `ids.from` ·
//     `record_title` · `display.list.columns`/`sort`/`options` · `display.record.badge`/
//     `color_by`/`subtitle` · `display.form.sections` · every `constraints` property name
//   every other collection source:  a mirror's `mirror_of` naming the field on this collection
//   ui-views:          `filter` (one hop through a reference included) and the `display` block
//   command-bindings:  `available_when` · `done_when`
//   the records:       the frontmatter key
//
// Each walker REWRITES A COPY and records where it wrote, so a dry run, a refusal and the real run
// are one traversal and cannot disagree about what is affected. A position that cannot be rewritten
// — a source `npm install` would erase, a mixin every collection listing it shares, a filter hop
// through a union — is recorded too, and the verb refuses naming every one of them.

/** A layout option that names a field by the role it plays (§3.5.1). */
const OPTION_FIELD_KEYS = FIELD_OPTIONS;
/** A layout option that names several. */
const OPTION_FIELD_LISTS = ['ref_fields', 'value_fields'];
/** A layout option that is a template. */
const OPTION_TEMPLATES = TEMPLATE_OPTIONS;

/** A position label back to its path from the document root: `constraints[0].if.properties.status`
 *  → `['constraints', 0, 'if', 'properties', 'status']`. Labels are built from field names and
 *  operator keys, neither of which carries a `.` or a `[`. */
const pathOf = (label) => [...label.matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map((m) => (m[2] !== undefined ? Number(m[2]) : m[1]));

/** A map with one key renamed in place — key order is form order, and a body field belongs last. */
const renameKey = (obj, from, to) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k === from ? to : k, v]));

/** Rewrite `{{ <from> …}}` inside a template string, keeping any filters after the pipe. Matched on
 *  the whole identifier so `{{ name }}` is not found inside `{{ full_name }}`. */
function rewriteTemplateField(tpl, from, to) {
	if (typeof tpl !== 'string') return tpl;
	return tpl.replace(new RegExp(`(\\{\\{\\s*)${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s*(?:\\||\\}\\}))`, 'g'), `$1${to}$2`);
}

/** A template key on `holder`, rewritten when it names the field. */
function renameInTemplate(holder, key, from, to, at, label) {
	const v = holder?.[key];
	if (typeof v !== 'string') return;
	const next = rewriteTemplateField(v, from, to);
	if (next !== v) { holder[key] = next; at(label); }
}

/** The four display sub-blocks — a collection's default view, and a ui-view's variant of it. */
function renameInDisplay(display, from, to, at, label) {
	if (!display || typeof display !== 'object') return;
	const ren = (v) => (v === from ? to : v);
	const list = display.list;
	if (Array.isArray(list?.columns) && list.columns.includes(from)) { list.columns = list.columns.map(ren); at(`${label}.list.columns`); }
	if (typeof list?.sort === 'string' && list.sort.replace(/^-/, '') === from) { list.sort = list.sort.replace(from, to); at(`${label}.list.sort`); }
	const opts = list?.options;
	if (opts && typeof opts === 'object') {
		for (const k of OPTION_FIELD_KEYS) if (opts[k] === from) { opts[k] = to; at(`${label}.list.options.${k}`); }
		for (const k of OPTION_FIELD_LISTS) if (Array.isArray(opts[k]) && opts[k].includes(from)) { opts[k] = opts[k].map(ren); at(`${label}.list.options.${k}`); }
		for (const k of OPTION_TEMPLATES) renameInTemplate(opts, k, from, to, at, `${label}.list.options.${k}`);
	}
	const rec = display.record;
	if (rec && typeof rec === 'object') {
		for (const k of ['badge', 'color_by']) if (rec[k] === from) { rec[k] = to; at(`${label}.record.${k}`); }
		renameInTemplate(rec, 'subtitle', from, to, at, `${label}.record.subtitle`);
	}
	(Array.isArray(display.form?.sections) ? display.form.sections : []).forEach((sec, i) => {
		if (Array.isArray(sec?.fields) && sec.fields.includes(from)) { sec.fields = sec.fields.map(ren); at(`${label}.form.sections[${i}]`); }
	});
}

/**
 * One constraint, at the level where its property names are THIS collection's fields: the root and
 * every combinator branch (`if`/`then`/`else`/`not`, `allOf`/`anyOf`/`oneOf`, a dependent schema).
 * Never inside `properties.<f>` — a nested `properties` there names the sub-fields of an object.
 */
function renameInConstraint(node, from, to, at, label) {
	if (!node || typeof node !== 'object' || Array.isArray(node)) return;
	if (node.properties && typeof node.properties === 'object' && from in node.properties) {
		node.properties = renameKey(node.properties, from, to);
		at(`${label}.properties.${from}`, undefined, to);
	}
	if (Array.isArray(node.required) && node.required.includes(from)) { node.required = node.required.map((r) => (r === from ? to : r)); at(`${label}.required`); }
	if (node.dependentRequired && typeof node.dependentRequired === 'object') {
		if (from in node.dependentRequired) { node.dependentRequired = renameKey(node.dependentRequired, from, to); at(`${label}.dependentRequired.${from}`, undefined, to); }
		for (const [k, list] of Object.entries(node.dependentRequired)) {
			if (Array.isArray(list) && list.includes(from)) { node.dependentRequired[k] = list.map((r) => (r === from ? to : r)); at(`${label}.dependentRequired.${k}`); }
		}
	}
	if (node.dependentSchemas && typeof node.dependentSchemas === 'object') {
		if (from in node.dependentSchemas) { node.dependentSchemas = renameKey(node.dependentSchemas, from, to); at(`${label}.dependentSchemas.${from}`, undefined, to); }
		for (const [k, sub] of Object.entries(node.dependentSchemas)) renameInConstraint(sub, from, to, at, `${label}.dependentSchemas.${k}`);
	}
	for (const k of ['if', 'then', 'else', 'not']) renameInConstraint(node[k], from, to, at, `${label}.${k}`);
	for (const k of ['allOf', 'anyOf', 'oneOf']) (Array.isArray(node[k]) ? node[k] : []).forEach((sub, i) => renameInConstraint(sub, from, to, at, `${label}.${k}[${i}]`));
}

/** Every position in one of the collection's OWN sources (its base, an overlay, a mixin it lists). */
function renameOwnField(doc, from, to, at) {
	if (doc.fields && typeof doc.fields === 'object') {
		if (from in doc.fields) { doc.fields = renameKey(doc.fields, from, to); at(`fields.${from}`, undefined, to); }
		for (const [k, f] of Object.entries(doc.fields)) {
			if (f?.display?.unit_field === from) { f.display.unit_field = to; at(`fields.${k}.display.unit_field`); }
		}
	}
	if (doc.storage?.under?.parent === from) { doc.storage.under.parent = to; at('storage.under.parent'); }
	if (Array.isArray(doc.ids?.from)) doc.ids.from.forEach((_, i) => renameInTemplate(doc.ids.from, i, from, to, at, `ids.from[${i}]`));
	else renameInTemplate(doc.ids, 'from', from, to, at, 'ids.from');
	renameInTemplate(doc, 'record_title', from, to, at, 'record_title');
	renameInDisplay(doc.display, from, to, at, 'display');
	(Array.isArray(doc.constraints) ? doc.constraints : []).forEach((c, i) => renameInConstraint(c, from, to, at, `constraints[${i}]`));
}

/** A mirror elsewhere naming the field it mirrors on `collection`. */
function renameMirrorOf(doc, collection, from, to, at) {
	for (const [k, f] of Object.entries(doc?.fields ?? {})) {
		const t = targetsOf(f);
		if (f?.mirror_of === from && Array.isArray(t) && t.length === 1 && t[0] === collection) { f.mirror_of = to; at(`fields.${k}.mirror_of`); }
	}
}

/**
 * A filter, read against the collection it filters. A key that is not an operator names a field of
 * `coll`; inside its condition, a further non-operator key is ONE HOP through that reference and
 * names a field of the collection it points at — so a view over visits filtering `patient: { name:
 * … }` names `health/patients.name`. A hop through a union cannot say which member's field it means.
 */
function walkFilter(node, coll, fieldsOfColl, visit, at, label) {
	if (!node || typeof node !== 'object' || Array.isArray(node)) return;
	for (const key of Object.keys(node)) {
		if (key === '_and' || key === '_or') {
			(Array.isArray(node[key]) ? node[key] : []).forEach((c, i) => walkFilter(c, coll, fieldsOfColl, visit, at, `${label}.${key}[${i}]`));
			continue;
		}
		if (key.startsWith('_')) continue;
		const cond = node[key];
		if (cond && typeof cond === 'object' && !Array.isArray(cond) && Object.keys(cond).some((k) => !k.startsWith('_'))) {
			const t = targetsOf(fieldsOfColl(coll)?.[key]);
			if (Array.isArray(t) && t.length === 1) walkFilter(cond, t[0], fieldsOfColl, visit, at, `${label}.${key}`);
			else if (Array.isArray(t)) visit.union?.(cond, t, at, `${label}.${key}`);
		}
		visit.field(node, key, coll, at, label);
	}
}

/** The ui-views and command-bindings of every source root, with the collection each one is over. */
function viewSources(store) {
	const out = [];
	for (const root of store.sourceRoots()) {
		for (const kind of ['ui-views', 'command-bindings']) {
			const dir = kindDir(root, kind);
			if (!fs.existsSync(dir)) continue;
			for (const file of [...walk(dir)]) {
				if (!/\.(ui-view|command-binding)\.yaml$/.test(file)) continue;
				out.push({ file, kind });
			}
		}
	}
	return out;
}

/** The filter positions of a view or a binding. */
const FILTER_KEYS = { 'ui-views': ['filter'], 'command-bindings': ['available_when', 'done_when'] };

/** Every mixin source, by id — a mixin is shared by every collection that lists it. */
function mixinSources(store) {
	const out = [];
	for (const root of store.sourceRoots()) {
		const dir = kindDir(root, 'mixins');
		if (!fs.existsSync(dir)) continue;
		for (const file of [...walk(dir)]) {
			const m = /([^/\\]+)\.mixin\.yaml$/.exec(file);
			if (m) out.push({ id: m[1], file });
		}
	}
	return out;
}

/** The mixins a collection's sources list. */
function mixinsListedBy(ws, collection) {
	const { base, overlays } = baseDescriptorSource(ws, collection);
	const ids = new Set();
	for (const rel of [base, ...overlays].filter(Boolean)) {
		const doc = readYaml(path.join(ws.root, rel));
		for (const m of Array.isArray(doc?.mixins) ? doc.mixins : []) ids.add(String(m));
	}
	return ids;
}

/** The mixin a collection takes `fieldName` from, or null. */
function mixinDeclaring(ws, store, collection, fieldName) {
	const listed = mixinsListedBy(ws, collection);
	for (const { id, file } of mixinSources(store)) {
		if (listed.has(id) && readYaml(file)?.fields?.[fieldName] !== undefined) return { id, rel: path.relative(ws.root, file) };
	}
	return null;
}

const readYaml = (file) => {
	try { return load(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

/**
 * Walk every source with `visit`, on copies. Returns `{ positions, edits }`: every position written
 * (`{ rel, at, fixed, why }`), and for each file that changed the rewritten document beside its
 * original text.
 *
 * `visit.own(doc, at)` runs on the collection's own sources and the mixins it lists;
 * `visit.foreign(doc, at)` on every collection source; `visit.view(doc, kind, at)` on every view and
 * binding.
 */
function walkSources(ws, store, collection, visit) {
	const positions = [];
	const edits = new Map();
	const record = (file, doc, before, why) => {
		const rel = path.relative(ws.root, file);
		const at = [];
		// `renamedTo` marks a position that is a mapping KEY renamed in place — written to the bytes
		// first (`renameKeys`), so the comments inside the pair stay with it
		const note = (label, reason, renamedTo, keyPath) => at.push({ label, reason, ...(renamedTo !== undefined && { key: { path: keyPath ?? pathOf(label), to: renamedTo } }) });
		return {
			note,
			done: () => {
				if (!at.length) return;
				const blocked = why ?? (IN_NODE_MODULES(rel) ? 'it ships from node_modules, and `npm install` would erase the write' : null);
				for (const a of at) positions.push({ rel, at: a.label, fixed: !blocked && !a.reason, why: a.reason ?? blocked ?? undefined });
				if (!blocked && !at.some((a) => a.reason)) edits.set(file, { before, doc, keys: at.filter((a) => a.key).map((a) => a.key) });
			},
		};
	};
	for (const file of descriptorSources(ws, store)) {
		const before = fs.readFileSync(file, 'utf8');
		const doc = load(before);
		if (!doc || typeof doc !== 'object') continue;
		const r = record(file, doc, before);
		if (doc.name === collection) visit.own(doc, r.note);
		visit.foreign?.(doc, r.note);
		r.done();
	}
	const listed = mixinsListedBy(ws, collection);
	for (const { id, file } of mixinSources(store)) {
		const before = fs.readFileSync(file, 'utf8');
		const doc = load(before);
		if (!doc || typeof doc !== 'object') continue;
		const r = record(file, doc, before, `mixin "${id}" is shared by every collection that lists it — rewrite it by hand, or move the field onto ${collection}`);
		if (listed.has(id)) visit.own(doc, r.note);
		visit.foreign?.(doc, r.note);
		r.done();
	}
	for (const { file, kind } of viewSources(store)) {
		const before = fs.readFileSync(file, 'utf8');
		const doc = load(before);
		if (!doc || typeof doc !== 'object') continue;
		const r = record(file, doc, before);
		visit.view(doc, kind, r.note);
		r.done();
	}
	return { positions, edits };
}

/** The collection a view or binding is over, bare. */
const viewCollection = (doc) => String(doc?.collection ?? '').replace(/^collections\//, '');

/** Records of `collection` a value-level rewrite would change, with the fields it would write. */
function recordRewrites(store, collection, rewrite) {
	const d = store.descriptors.get(collection);
	if (!d || !store.canRewrite(collection)) return [];
	const bf = bodyFieldOf(d);
	const out = [];
	for (const [, file] of store.ids(collection)) {
		let fields;
		// a record that will not parse is skipped: `check` already reports it, and one bad record must
		// not wall off a schema change
		try { fields = parseRecord(file, d, bf); } catch { continue; }
		const next = rewrite(fields);
		// the previous text goes with it, so a rewrite re-emits only the key it changed
		if (next) out.push({ file, fields: next, text: fs.readFileSync(file, 'utf8') });
	}
	return out;
}

/** The refusal every positional verb gives: the positions it cannot rewrite, each with why. */
function refusePositions(what, positions) {
	const blocked = positions.filter((p) => !p.fixed);
	if (!blocked.length) return;
	throw new Error(`${what} cannot rewrite ${blocked.length} position${blocked.length === 1 ? '' : 's'} — nothing was changed:\n${blocked.map((p) => `  ${p.rel}  ${p.at} — ${p.why}`).join('\n')}`);
}

/** Write a walk's rewritten documents and records, inside a gate op; returns the touched paths. */
function applyRewrites(ws, edits, records, cd, snap) {
	const touched = new Set();
	for (const [file, { before, doc, keys }] of edits) {
		const after = writeSource(keys.length ? renameKeys(before, keys) : before, doc);
		if (!load(after) || commentCount(after) < commentCount(before)) {
			throw new Error(`could not rewrite ${path.relative(ws.root, file)} without losing a comment — nothing was changed.`);
		}
		snap(file);
		fs.writeFileSync(file, after);
		touched.add(path.relative(ws.root, file));
	}
	for (const { file, fields, text } of records) {
		snap(file);
		atomicWrite(file, serialize(cd, fields, text));
		touched.add(path.relative(ws.root, file));
	}
	return touched;
}

// ---- rename-field ------------------------------------------------------------------------------

/** Every position a rename of `collection.from` → `to` rewrites, the records it rewrites, and what
 *  it cannot. Read-only: the dry run IS this. */
function fieldRenameWalk(ws, store, collection, from, to, { records: withRecords = true } = {}) {
	const fieldsOfColl = (c) => (store.descriptors.has(c) ? fieldsOf(store.descriptor(c)) : {});
	const visit = {
		own: (doc, at) => renameOwnField(doc, from, to, at),
		foreign: (doc, at) => renameMirrorOf(doc, collection, from, to, at),
		view: (doc, kind, at) => {
			const over = viewCollection(doc);
			if (over === collection && kind === 'ui-views') renameInDisplay(doc.display, from, to, at, 'display');
			for (const key of FILTER_KEYS[kind]) {
				walkFilter(doc[key], over, fieldsOfColl, {
					field: (node, k, coll, note, label) => {
						if (coll !== collection || k !== from) return;
						const rebuilt = renameKey(node, from, to);
						for (const x of Object.keys(node)) delete node[x];
						Object.assign(node, rebuilt);
						note(`${label}.${from}`, undefined, to);
					},
					union: (cond, targets, note, label) => {
						if (targets.includes(collection) && from in cond) note(`${label}.${from}`, `a filter hop through a union (${targets.join(', ')}) cannot say which member's "${from}" it means — rewrite it by hand`);
					},
				}, at, key);
			}
		},
	};
	const { positions, edits } = walkSources(ws, store, collection, visit);
	const d = store.descriptor(collection);
	// the body field has no frontmatter key: its value is the prose, which `serialize` writes back under
	// whatever the descriptor now calls it — the rename, done
	const records = !withRecords || from === bodyFieldOf(d) ? [] : recordRewrites(store, collection, (fields) => (from in fields ? renameKey(fields, from, to) : null));
	return { positions, edits, records };
}

export function renameFieldPlan(ws, store, collection, from, to) {
	const d = store.descriptor(collection);
	if (!fieldsOf(d)[from]) throw new Error(`no field "${from}" on ${collection}`);
	const { positions, records } = fieldRenameWalk(ws, store, collection, from, to ?? `<new-name>`);
	return {
		collection, from, to, positions, records: records.length, refs: 0, cleared: 0,
		descriptors: new Set(positions.map((p) => p.rel)).size,
	};
}

export function renameField(ws, store, collection, from, to, { dryRun = false } = {}) {
	const d = store.descriptor(collection);
	if (!to || to === true) throw new Error(`missing --to <new-name>: dreamteamer rename-field ${collection} --name ${from} --to <new-name>`);
	if (from === to) return { renamed: false, collection, from, to };
	const fields = fieldsOf(d);
	if (!fields[from]) throw new Error(`no field "${from}" on ${collection}`);
	if (INJECTED.has(from)) throw new Error(`"${from}" is injected by the engine into every collection — it cannot be renamed`);
	if (fields[to] || INJECTED.has(to)) throw new Error(`${collection} already has a field "${to}" — pick another name, or remove it first (dreamteamer rm-field ${collection} --name ${to}).`);
	const plan = renameFieldPlan(ws, store, collection, from, to);
	if (dryRun) return { ...plan, renamed: false, dryRun: true };
	refusePositions(`rename-field ${collection} ${from} → ${to}`, plan.positions);

	const snapshots = new Map();
	const snap = (f) => { if (!snapshots.has(f)) snapshots.set(f, fs.readFileSync(f)); };
	const out = gatedTreeOp(ws, store, {
		subject: `dreamteamer: ${collection} rename-field ${from} → ${to}`,
		paths: [],
		mutate: () => {
			// walked again INSIDE the lock, so what is written is what is on disk now
			const walked = fieldRenameWalk(ws, store, collection, from, to);
			refusePositions(`rename-field ${collection} ${from} → ${to}`, walked.positions);
			return { paths: [...applyRewrites(ws, walked.edits, walked.records, d, snap)] };
		},
		undo: () => { for (const [f, bytes] of snapshots) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, bytes); } },
	});
	return { ...plan, renamed: true, commits: out.commits };
}

// ---- rename-value ------------------------------------------------------------------------------
// The value half of rule 6: an enum value is named by the field's `enum` (a list, or the key of a
// decorated map), its `default`, a constraint's `const`/`enum` on that field, a view filter and a
// binding condition on it, and every record holding it.

/** Rewrite the value inside one field's subschema of a constraint. */
function renameValueInSubschema(s, from, to, at, label) {
	if (!s || typeof s !== 'object' || Array.isArray(s)) return;
	if (s.const === from) { s.const = to; at(`${label}.const`); }
	if (Array.isArray(s.enum) && s.enum.includes(from)) { s.enum = s.enum.map((v) => (v === from ? to : v)); at(`${label}.enum`); }
	for (const k of ['items', 'contains', 'not', 'if', 'then', 'else']) renameValueInSubschema(s[k], from, to, at, `${label}.${k}`);
	for (const k of ['allOf', 'anyOf', 'oneOf']) (Array.isArray(s[k]) ? s[k] : []).forEach((sub, i) => renameValueInSubschema(sub, from, to, at, `${label}.${k}[${i}]`));
}

/** A constraint, at its root-level positions, for the subschemas that constrain `field`. */
function renameValueInConstraint(node, field, from, to, at, label) {
	if (!node || typeof node !== 'object' || Array.isArray(node)) return;
	if (node.properties?.[field]) renameValueInSubschema(node.properties[field], from, to, at, `${label}.properties.${field}`);
	for (const k of ['if', 'then', 'else', 'not']) renameValueInConstraint(node[k], field, from, to, at, `${label}.${k}`);
	for (const k of ['allOf', 'anyOf', 'oneOf']) (Array.isArray(node[k]) ? node[k] : []).forEach((sub, i) => renameValueInConstraint(sub, field, from, to, at, `${label}.${k}[${i}]`));
	for (const [k, sub] of Object.entries(node.dependentSchemas ?? {})) renameValueInConstraint(sub, field, from, to, at, `${label}.dependentSchemas.${k}`);
}

/** Operators whose operand IS a value, rewritten exactly. */
const VALUE_OPS = ['_eq', '_neq', '_ieq', '_nieq'];
const LIST_OPS = ['_in', '_nin'];
/** Operators whose operand matches PART of a value: a rename can change what they select, and no
 *  mechanical rewrite says how — so one that selects the old value is refused by name. */
const PARTIAL_OPS = {
	_contains: (v, o) => v.includes(o), _ncontains: (v, o) => v.includes(o), _icontains: (v, o) => v.toLowerCase().includes(o.toLowerCase()),
	_starts_with: (v, o) => v.startsWith(o), _istarts_with: (v, o) => v.toLowerCase().startsWith(o.toLowerCase()),
	_ends_with: (v, o) => v.endsWith(o), _iends_with: (v, o) => v.toLowerCase().endsWith(o.toLowerCase()),
	_regex: (v, o) => { try { return new RegExp(o).test(v); } catch { return false; } },
};

/** One field's condition in a filter, with the value rewritten. */
function renameValueInCondition(node, key, from, to, at, label) {
	const cond = node[key];
	if (cond === from) { node[key] = to; at(`${label}.${key}`); return; }
	if (!cond || typeof cond !== 'object' || Array.isArray(cond)) return;
	for (const op of VALUE_OPS) if (cond[op] === from) { cond[op] = to; at(`${label}.${key}.${op}`); }
	for (const op of LIST_OPS) {
		const o = cond[op];
		if (Array.isArray(o) && o.includes(from)) { cond[op] = o.map((v) => (v === from ? to : v)); at(`${label}.${key}.${op}`); }
		else if (typeof o === 'string' && o.split(',').map((x) => x.trim()).includes(from)) { cond[op] = o.split(',').map((x) => (x.trim() === from ? to : x.trim())).join(','); at(`${label}.${key}.${op}`); }
	}
	for (const [op, selects] of Object.entries(PARTIAL_OPS)) {
		if (typeof cond[op] === 'string' && cond[op] !== '' && selects(from, cond[op])) at(`${label}.${key}.${op}`, `\`${op}: ${cond[op]}\` selects "${from}" by part of its spelling — say what it should select now, by hand`);
	}
}

function valueRenameWalk(ws, store, collection, field, from, to) {
	const fieldsOfColl = (c) => (store.descriptors.has(c) ? fieldsOf(store.descriptor(c)) : {});
	const visit = {
		own: (doc, at) => {
			const f = doc.fields?.[field];
			if (f && typeof f === 'object') {
				if (Array.isArray(f.enum) && f.enum.includes(from)) { f.enum = f.enum.map((v) => (v === from ? to : v)); at(`fields.${field}.enum`); }
				else if (f.enum && typeof f.enum === 'object' && from in f.enum) { f.enum = renameKey(f.enum, from, to); at(`fields.${field}.enum`, undefined, to, ['fields', field, 'enum', from]); }
				if (f.default === from) { f.default = to; at(`fields.${field}.default`); }
				else if (Array.isArray(f.default) && f.default.includes(from)) { f.default = f.default.map((v) => (v === from ? to : v)); at(`fields.${field}.default`); }
			}
			(Array.isArray(doc.constraints) ? doc.constraints : []).forEach((c, i) => renameValueInConstraint(c, field, from, to, at, `constraints[${i}]`));
		},
		view: (doc, kind, at) => {
			for (const key of FILTER_KEYS[kind]) {
				walkFilter(doc[key], viewCollection(doc), fieldsOfColl, {
					field: (node, k, coll, note, label) => { if (coll === collection && k === field) renameValueInCondition(node, k, from, to, note, label); },
					union: (cond, targets, note, label) => {
						if (targets.includes(collection) && field in cond) note(`${label}.${field}`, `a filter hop through a union (${targets.join(', ')}) cannot say which member's "${field}" it means — rewrite it by hand`);
					},
				}, at, key);
			}
		},
	};
	const { positions, edits } = walkSources(ws, store, collection, visit);
	const records = recordRewrites(store, collection, (fields) => {
		const v = fields[field];
		if (v === from) return { ...fields, [field]: to };
		if (Array.isArray(v) && v.includes(from)) return { ...fields, [field]: v.map((x) => (x === from ? to : x)) };
		return null;
	});
	return { positions, edits, records };
}

/** The checks a value rename is held to before anything is walked. */
function valueRenameTarget(store, collection, field, from, to) {
	const f = fieldsOf(store.descriptor(collection))[field];
	if (!f) throw new Error(`no field "${field}" on ${collection}`);
	const values = f.enum === undefined ? null : enumValues(f.enum);
	if (!values) throw new Error(`${collection}.${field} has no enum — rename-value renames one value of an enum; a free value is rewritten with dreamteamer set`);
	if (!values.includes(from)) throw new Error(`"${from}" is not a value of ${collection}.${field} — its enum is ${values.join(', ')}`);
	if (to === undefined || to === true || to === '') throw new Error(`missing <new>: dreamteamer rename-value ${collection} ${field} ${from} <new>`);
	if (values.includes(to)) throw new Error(`"${to}" is already a value of ${collection}.${field} — merging two values is a record edit, not a rename`);
}

export function renameValuePlan(ws, store, collection, field, from, to) {
	valueRenameTarget(store, collection, field, from, to);
	const { positions, records } = valueRenameWalk(ws, store, collection, field, from, to);
	return {
		collection, field, from, to, positions, records: records.length, refs: 0, cleared: 0,
		descriptors: new Set(positions.map((p) => p.rel)).size,
	};
}

export function renameValue(ws, store, collection, field, from, to, { dryRun = false } = {}) {
	const plan = renameValuePlan(ws, store, collection, field, from, to);
	if (dryRun) return { ...plan, renamed: false, dryRun: true };
	refusePositions(`rename-value ${collection} ${field} ${from} → ${to}`, plan.positions);
	const d = store.descriptor(collection);
	const snapshots = new Map();
	const snap = (f) => { if (!snapshots.has(f)) snapshots.set(f, fs.readFileSync(f)); };
	const out = gatedTreeOp(ws, store, {
		subject: `dreamteamer: ${collection} rename-value ${field} ${from} → ${to}`,
		paths: [],
		mutate: () => {
			const walked = valueRenameWalk(ws, store, collection, field, from, to);
			refusePositions(`rename-value ${collection} ${field} ${from} → ${to}`, walked.positions);
			return { paths: [...applyRewrites(ws, walked.edits, walked.records, d, snap)] };
		},
		undo: () => { for (const [f, bytes] of snapshots) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, bytes); } },
	});
	return { ...plan, renamed: true, commits: out.commits };
}

/** The workspace's writable source dir for a kind (workspace_module aware). `kindDir` picks the
 *  layout that module already uses and falls back to flat, so a `collections add` never splits a
 *  half-moved module across both. */
export function workspaceSystemDir(ws, kind) {
	const wm = ws.pkg.dreamteamer?.workspace_module;
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
 * Returns `{ dir, file, overlays, sources }` — the base's kind dir to write into (the SAME module the
 * descriptor came from, so a rename never teleports a collection into the workspace module) and its
 * file; each overlay as `{ dir, file }` in ITS module, so the rename carries it along; and every
 * descriptor source that contributed, so the caller can refuse the cases this cannot honestly do.
 */
function descriptorSourceDir(ws, name) {
	// The base is the source without `overlay: true` — see baseDescriptorSource; discovery order
	// says nothing about which source is which.
	const { base, overlays, sources } = baseDescriptorSource(ws, name);
	// ⚠ `dir` IS THE OWNING MODULE'S `collections/` KIND DIR — asked of the manifest's module list,
	// not re-derived by stripping the collection's name off the source path. That arithmetic only
	// worked while the source path mirrored the name, which a module owning its own namespace need
	// not do (see baseDescriptorSource). `file` is the ACTUAL path, so a caller renaming it moves the
	// file that exists rather than a path it assumed.
	const roots = (readManifest(ws.root)?.modules ?? []).map((m) => (m.root === '.' ? '' : `${m.root}/`));
	const at = (rel) => {
		const mod = roots.filter((r) => r === '' || rel.startsWith(r)).sort((a, b) => b.length - a.length)[0] ?? '';
		return { dir: kindDir(path.join(ws.root, mod), 'collections'), file: path.join(ws.root, rel) };
	};
	if (!base) return { dir: null, file: null, overlays: overlays.map(at), sources };
	return { ...at(base), overlays: overlays.map(at), sources };
}

/**
 * THE BASE DESCRIPTOR SOURCE, and the overlays beside it — asked of the manifest, decided by parsing.
 *
 * `descriptorSourceDir` above assumes `sources[0]` is the base, which is true in discovery order and
 * is not a fact anything checks. Every EDIT verb needs the base specifically — the rule is that
 * `set`, `rm`, `rename` and the field verbs act on the module that owns the entity and never teleport
 * it into the workspace module — so the base is identified the only way it is actually defined: it is
 * the contributing source that does not declare `overlay: true`.
 *
 * Returns workspace-relative paths. `base` is null when nothing in this workspace declares it (the
 * engine's own nine collections reach here that way), which is the signal to write an overlay.
 */
export function baseDescriptorSource(ws, name) {
	const suffix = `collections/${name}.collection.yaml`;
	const sources = (readManifest(ws.root)?.entries?.[suffix]?.sources ?? [])
		// sources are `{path, hash}`; tolerate the pre-0.10 string form, as compile's staleness does
		.map((s) => (typeof s === 'string' ? s : s?.path))
		// ⚠ MATCHED ON THE KIND, not on the source path mirroring the collection's NAME. This used
		// to require `endsWith('collections/<name>.collection.yaml')`, which assumes a namespaced
		// descriptor is authored NESTED — true of what `dt add collections` writes, and NOT true of a
		// module that authors `collections/positions.collection.yaml` with `name: hr/positions`,
		// which is the ordinary shape for a module that OWNS its namespace (§8) and does not want to
		// repeat it in every path. Measured on a scratch workspace: that module's base was invisible
		// here, so `add-field hr/positions` created an overlay in the WORKSPACE module and failed
		// compile for a dependency nobody asked for — the exact defect this wave exists to remove,
		// surviving one layer down. `sources` is already scoped to THIS collection's manifest entry;
		// the only other thing in it is a merged MIXIN, whose suffix differs.
		.filter((p) => typeof p === 'string' && p.endsWith('.collection.yaml'));
	let base = null;
	const overlays = [];
	for (const rel of sources) {
		const file = path.join(ws.root, rel);
		if (!fs.existsSync(file)) continue;
		let doc;
		try { doc = load(fs.readFileSync(file, 'utf8')); } catch { continue; }
		if (doc?.overlay === true) overlays.push(rel);
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
			throw new Error(`module "${moduleId}" ships from node_modules (${rec.fields.path}) — a write there is erased by the next \`npm install\`.\n  to add fields from this workspace: dreamteamer add-field ${collection} --name <f> --module ${ws.pkg.dreamteamer?.workspace_module ?? 'default'}`);
		}
		// ⚠ A SELECTOR SELECTS AMONG THINGS. `--module` is only meaningful where the entity is
		// declared by MORE than one module (a base plus overlays); anywhere else it is refused (§5),
		// naming who does declare it. `allowNew` is the one caller deliberately CREATING an overlay.
		const declared = declaringModules(ws, store, collection);
		// naming the ONLY declarer is redundant even where an overlay may be created: it selects the base
		if (declared.length < 2 && (!allowNew || declared.includes(moduleId))) {
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

export function createCollection(ws, store, { name, mixins, idFrom, namespace, moduleId, description, suffix }) {
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
	// ⚠ THE NAME AS TYPED, TOO, not only the qualified one. Namespace inference (§8) turns
	// `--name people --module hr` into `hr/people`, which is a DIFFERENT collection — so with the
	// qualified check alone, asking to create a collection that already exists silently created a
	// second one in the module's namespace. §13 requires the refusal, and it has to fire on the name
	// the operator actually typed.
	for (const clash of new Set([qualified, name])) {
		if (!store.descriptors.has(clash)) continue;
		// §13: name both remedies, because the operator asking for this wants ONE of them and the
		// generic "already exists" tells them which neither.
		const owner = moduleOf(store.descriptors.get(clash));
		const target = moduleId ?? ws.pkg.dreamteamer?.workspace_module ?? 'default';
		throw new Error(`collection "${clash}" already exists, owned by ${owner}. Fields from ${target}: dreamteamer add-field ${clash} --module ${target} --name <f> --type <t> · move it: dreamteamer set collections/${clash} module=${target}`);
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

	// THE MINIMAL v2 DESCRIPTOR, in canonical key order: `name`, a `description` when one is given,
	// the mixins, the id rule, and `fields`. Storage, title and singular are compile's to default —
	// a default written into the source is a value nobody chose, and it stops following the name.
	// Without a mixin the collection gets the one field its records are named by; with one, the mixin
	// supplies the fields and `add-field` grows the rest.
	const mixinList = mixins === undefined || mixins === '' ? [] : nameList(mixins);
	const descriptor = { name: qualified };
	// ⚠ A DESCRIPTION IS NOT DECORATION. compile WARNS about a collection without one, because it
	// renders as a bare NAME in the orientation block every session loads — an agent learns the noun
	// exists and nothing about when it is the right one.
	if (typeof description === 'string' && description) descriptor.description = description;
	if (mixinList.length) descriptor.mixins = mixinList;
	if (typeof idFrom === 'string' && idFrom) descriptor.ids = { from: idFrom };
	// An explicit suffix WINS over the derivation, and the derivation is echoed by the caller either
	// way: every record filename carries it (`<id>.<suffix>.md`).
	if (typeof suffix === 'string' && suffix) descriptor.storage = { suffix };
	descriptor.fields = mixinList.length ? {} : { name: { type: 'string', required: true } };
	// the SUFFIX comes off the bare name — `health/doctors` records are `<id>.doctor.md`, not
	// `<id>.health/doctor.md` — exactly as compile derives it
	const effectiveSuffix = descriptor.storage?.suffix ?? singular(baseNameOf(qualified, declaredAll));
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
		suffix: effectiveSuffix,
		suffixDerived: suffix === undefined || suffix === '',
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
		throw new Error(`"${name}" has no writable descriptor source — the manifest names none under a module in this workspace. It may be contributed by the engine itself; add "collections/${name}" to dreamteamer.disable instead.`);
	}
	if (IN_NODE_MODULES(base)) {
		throw new Error(`"${name}" ships from node_modules (${base}) — a write there is erased by the next \`npm install\`. Add "collections/${name}" to dreamteamer.disable instead.`);
	}
	// An overlay with no base fails compile ("every source declares `overlay: true` — no base found"),
	// so removing the base under a live overlay is a half-migration that cannot compile.
	if (overlays.length) {
		throw new Error(`"${name}" is overlaid by ${overlays.join(', ')} — an overlay cannot compile without its base, so removing the base alone would break the workspace. Remove the overlay first: dreamteamer rm-field ${name} --module <overlay-module> --name <field> (removing its last field removes the overlay).`);
	}
	const dest = path.join(ws.root, base);
	const storage = storageOf(d);
	const dataDir = path.join(ws.root, storage.path);
	// the index, not only the folder: a collection stored UNDER another keeps most of its records
	// inside the parent's folders, where a readdir of its own root sees nothing
	const hasRecords = store.ids(name).size > 0 || (fs.existsSync(dataDir) && fs.readdirSync(dataDir).some((e) => !e.startsWith('.')));
	if (hasRecords && !force) throw new Error(`collection "${name}" still has records under ${storage.path}${storage.under ? ` and inside ${storage.under.collection} folders` : ''} — remove them first or pass force`);
	for (const c of store.descriptors.values()) {
		if (storageOf(c).under?.collection === name) throw new Error(`collection "${c.name}" stores its records under ${name}'s folders (storage.under) — drop that declaration or relocate its records first; removing the parent would strand them`);
	}
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
	if (isRuntime(d)) throw new Error(`"${oldName}" is a compiled source, not a data collection — it cannot be renamed`);
	// Its records are spread across the parent's folders, and the per-file re-suffix below walks ONE
	// directory. Refused rather than half-done — the fix is small and nothing has asked for it yet.
	if (storageOf(d).under) throw new Error(`"${oldName}" is stored under ${storageOf(d).under.collection} (storage.under) — renaming a placed collection is not supported yet. The supported order: dreamteamer relocate ${oldName} --to-root · remove storage.under from its descriptor · compile · rename · declare storage.under again · compile · dreamteamer relocate ${newName}`);

	// The descriptor is renamed IN THE MODULE THAT SHIPS IT — see `descriptorSourceDir` — and so is
	// every overlay of it, each in its own module: an overlay names only the collection, so one left
	// behind would overlay a collection with no base. Refused where doing it halfway is worse than not
	// doing it:
	const { dir: sourceDir, file: sourceFile, overlays, sources } = descriptorSourceDir(ws, oldName);
	const shipped = sources.find((p) => IN_NODE_MODULES(p));
	if (shipped) {
		throw new Error(`"${oldName}" ships from node_modules (${shipped}) — a write there is erased by the next \`npm install\`. rename it in its own repo and release.`);
	}
	// An overlay's `storage` wins over the base's, and the path and suffix are re-derived from the
	// base's below — so an overlay that sets either has no rename this can do honestly.
	const overlayMoves = overlays.map(({ dir, file }) => {
		const text = fs.readFileSync(file, 'utf8');
		const odoc = load(text);
		const set = ['path', 'suffix'].filter((k) => odoc?.storage?.[k] !== undefined);
		if (set.length) throw new Error(`${path.relative(ws.root, file)} overlays "${oldName}" and sets storage.${set.join(' and storage.')} — move ${set.length === 1 ? 'it' : 'them'} into the base descriptor, then rename. nothing was renamed.`);
		const to = path.join(dir, `${newName}.collection.yaml`);
		if (to !== file && fs.existsSync(to)) throw new Error(`${path.relative(ws.root, to)} already exists — move or remove it first; nothing was renamed`);
		return { file, to, text, doc: odoc };
	});
	// The base's ACTUAL path, not one rebuilt from the name — a module that owns its namespace may
	// author `collections/positions.collection.yaml` as `hr/positions`, and rebuilding the path then
	// named a file that does not exist.
	const src = sourceFile ?? path.join(workspaceSystemDir(ws, 'collections'), `${oldName}.collection.yaml`);
	const dest = path.join(sourceDir ?? workspaceSystemDir(ws, 'collections'), `${newName}.collection.yaml`);
	if (!fs.existsSync(src)) {
		throw new Error(`"${oldName}" has no writable descriptor source — the manifest names none under a module in this workspace. it may be contributed by the engine itself.`);
	}

	const doc = load(fs.readFileSync(src, 'utf8'));
	const dataPath = ws.pkg.dreamteamer?.data_path ?? 'data';
	// `d` is the COMPILED descriptor, so its storage.path already carries any module prefix; the
	// authored source is what we compare against, and what we rewrite.
	const authoredPath = String(doc.storage?.path ?? '');
	const pathWasDerived = authoredPath === '' || authoredPath === defaultStoragePath(oldName, declared, dataPath);
	const newPath = pathWasDerived ? defaultStoragePath(newName, declared, dataPath) : authoredPath;

	const oldBase = baseNameOf(oldName, declared);
	const newBase = baseNameOf(newName, declared);
	const oldSuffix = storageOf(d).suffix;
	// AUTHORED is the test: an absent suffix is compile's default and follows the name by itself. An
	// authored one that merely spells the old default is re-derived too, so filenames keep telling the
	// truth about what they hold.
	const authoredSuffix = doc.storage?.suffix;
	const suffixWasDerived = authoredSuffix === undefined || authoredSuffix === singular(oldBase);
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
		for (const o of overlayMoves) {
			fs.mkdirSync(path.dirname(o.file), { recursive: true });
			fs.writeFileSync(o.file, o.text);
			if (o.to !== o.file) fs.rmSync(o.to, { force: true });
		}
	};

	return store.withWriteLock(() => {
		// ⚠ THERE IS NO CAPTURE PASS ANY MORE. This used to ask `findInboundRefs` per id — a full walk
		// of every record file — purely to snapshot the referencing files for rollback, and then step 2
		// walked them all again to rewrite them: the same bytes read twice, per id. The rewrite
		// snapshots what it writes as it writes it (`store.rewriteRefsBatch`), so its own `restore` is
		// the rollback and the pre-walk is pure cost. `refFiles` holds the sources steps 4 and 5
		// rewrite (descriptors, mixins, views, package.json files), which no record walk visits.
		const refFiles = new Map();
		const rootPkg = path.join(ws.root, 'package.json');
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
			// A rename changes `name`, and `storage.path`/`storage.suffix` only where they are AUTHORED —
			// an absent one is compile's default and follows the name by itself. `writeSource` rewrites
			// exactly those; every other byte is restored from the source it was parsed out of. The parse
			// afterwards still proves the edit landed rather than trusting the writer, and the comment
			// count is asserted here because a rename does not go through `writeGated`'s invariant.
			const beforeText = srcBytes.toString('utf8');
			doc.name = newName;
			if (authoredPath !== '') doc.storage.path = newPath;
			if (authoredSuffix !== undefined) doc.storage.suffix = newSuffix;
			const edited = writeSource(beforeText, doc);
			const parsed = load(edited);
			if (parsed?.name !== newName || (authoredPath !== '' && parsed?.storage?.path !== newPath) || (authoredSuffix !== undefined && parsed?.storage?.suffix !== newSuffix)) {
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
			// each overlay the same way: only its `name` changes, round-tripped over its own bytes
			for (const o of overlayMoves) {
				o.doc.name = newName;
				const out = writeSource(o.text, o.doc);
				if (load(out)?.name !== newName || commentCount(out) < commentCount(o.text)) {
					throw new Error(`could not rewrite ${path.relative(ws.root, o.file)} in place — its name did not take without reformatting it. nothing was changed.`);
				}
				fs.mkdirSync(path.dirname(o.to), { recursive: true });
				fs.writeFileSync(o.to, out);
				if (o.to !== o.file) fs.rmSync(o.file);
				touched.add(o.file);
				touched.add(o.to);
			}

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
				const old = { storage: { ...storageOf(d), suffix: oldSuffix } };
				for (const file of walk(newDir)) {
					const id = idFromRecordPath(old, path.relative(newDir, file));
					if (id === null) continue;
					const to = path.join(newDir, `${id}.${newSuffix}${path.basename(file).slice(path.basename(id).length + oldSuffix.length + 1)}`);
					fs.renameSync(file, to);
					resuffixed.push([file, to]);
				}
			}
			if (movedData) { touched.add(oldDir); touched.add(newDir); }

			// 4. every SOURCE naming the collection bare: a field's `type` (scalar or union, nested
			//    object fields and map values included) in every collection and mixin, and the
			//    `collection: collections/<name>` a ui-view or binding is over. Not a `<collection>/<id>`
			//    ref, so step 2 cannot see it — and leaving it makes compile fail on an unknown type.
			//
			// ⚠ ROUND-TRIPPED, for the same reason step 1 is: a descriptor's comments are where its
			// module writes down why the collection exists. The edit is made on the parsed value and
			// `writeSource` puts it back over the original bytes; the parse afterwards proves it landed.
			const sourcesNaming = [
				...descriptorSources(ws, store).map((f) => ({ f, edit: (doc) => retargetTypes(doc.fields, oldName, newName) })),
				...mixinSources(store).map(({ file }) => ({ f: file, edit: (doc) => retargetTypes(doc.fields, oldName, newName) })),
				...viewSources(store).map(({ file }) => ({ f: file, edit: (doc) => {
					if (doc.collection !== `collections/${oldName}`) return false;
					doc.collection = `collections/${newName}`;
					return true;
				} })),
			];
			for (const { f, edit } of sourcesNaming) {
				const before = fs.readFileSync(f, 'utf8');
				const probe = load(before);
				if (!probe || typeof probe !== 'object' || !edit(probe)) continue;
				const after = writeSource(before, probe);
				const reparsed = load(after);
				if (!reparsed || edit(reparsed) || commentCount(after) < commentCount(before)) {
					throw new Error(`could not retarget "${oldName}" in ${path.relative(ws.root, f)} without reformatting it — nothing was changed.`);
				}
				if (!refFiles.has(f)) refFiles.set(f, Buffer.from(before));
				fs.writeFileSync(f, after);
				touched.add(f);
				rewrites++;
			}

			// 5. every module's `dreamteamer.peer_collections` naming the collection: the list that
			//    lets a module overlay or reference it while it is installed. Step 4 retargeted those
			//    types and overlays, so a peer list left on the old name makes compile refuse them.
			for (const f of modulePackageFiles(ws)) {
				const before = fs.readFileSync(f, 'utf8');
				let pkg;
				try { pkg = JSON.parse(before); } catch { continue; }
				const peers = pkg?.dreamteamer?.peer_collections;
				if (!Array.isArray(peers) || !peers.includes(oldName)) continue;
				pkg.dreamteamer.peer_collections = peers.map((p) => (p === oldName ? newName : p));
				if (!refFiles.has(f)) refFiles.set(f, Buffer.from(before));
				fs.writeFileSync(f, JSON.stringify(pkg, null, '\t') + '\n');
				if (f === rootPkg) refreshWorkspacePkg(ws);
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
			if (refFiles.has(rootPkg)) refreshWorkspacePkg(ws);
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
			if (refFiles.has(rootPkg)) refreshWorkspacePkg(ws);
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
 * `repoRootOf` (compile.js, there since `owns_data` needed it) answers "which repo holds this path"
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

/** Every package.json in this workspace that can declare `peer_collections` — the workspace's own
 *  and each module's outside node_modules (a write there is erased by the next install). */
function modulePackageFiles(ws) {
	const roots = new Set(['.', ...(readManifest(ws.root)?.modules ?? []).map((m) => m.root)]);
	return [...roots]
		.filter((r) => typeof r === 'string' && !IN_NODE_MODULES(r))
		.map((r) => path.join(ws.root, r, 'package.json'))
		.filter((f) => fs.existsSync(f));
}

/** Re-read the workspace package.json into `ws.pkg` in place — `compile({root, pkg})` reads the
 *  object it was handed, not the file. */
function refreshWorkspacePkg(ws) {
	let pkg;
	try { pkg = JSON.parse(fs.readFileSync(path.join(ws.root, 'package.json'), 'utf8')); } catch { return; }
	for (const k of Object.keys(ws.pkg)) delete ws.pkg[k];
	Object.assign(ws.pkg, pkg);
}

/** Rewrite a field `type` naming `oldName` → `newName` — a scalar type or a union member, at any
 *  depth of object `fields` and map `values`. Returns true if anything changed. */
function retargetTypes(fields, oldName, newName) {
	let changed = false;
	for (const f of Object.values(fields ?? {})) {
		if (!f || typeof f !== 'object') continue;
		if (f.type === oldName) { f.type = newName; changed = true; }
		else if (Array.isArray(f.type) && f.type.includes(oldName)) { f.type = f.type.map((t) => (t === oldName ? newName : t)); changed = true; }
		if (f.fields && retargetTypes(f.fields, oldName, newName)) changed = true;
		if (f.values && typeof f.values === 'object') {
			if (f.values.type !== undefined && retargetTypes({ v: f.values }, oldName, newName)) changed = true;
		} else if (f.values === oldName) { f.values = newName; changed = true; }
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

// ---- the field verbs ----------------------------------------------------------------------------
// A field is one entry of a descriptor's `fields` map, in the vocabulary a person writes (`type:
// date`, `many: true`, `mirror_of: patient`). The verbs build that entry from flags, place it in the
// source that declares it, and write it through the YAML document, so every comment and every
// untouched byte stays where its author put it.

/** The order a field's keys are written in (§3.4.1): facts about the data, `display`, then what it means. */
const FIELD_KEY_ORDER = ['type', 'title', 'required', 'many', 'default', 'enum', 'unique', 'mirror_of', 'on_delete', 'soft', 'sensitive', 'body', 'derived', 'virtual', 'deprecated', 'passthrough', 'fields', 'values', 'item_title', 'examples', 'pattern', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'const', 'display', 'description'];

/** The three fields compile injects into every collection — no source declares one. */
const INJECTED = new Set(['id', 'created', 'last_modified']);

/** `--type`: a built-in type, a collection, `a,b` for a union of collections, or `reference`. A
 *  collection may not be named after a built-in type (compile refuses it), so the two never collide. */
function parseType(store, raw) {
	const known = `one of ${SCALAR_TYPES.join(' ')}, a collection name, or a,b for a union of collections`;
	if (raw === true || raw === '') throw new Error(`--type takes a value — ${known}`);
	const parts = String(raw).split(',').map((x) => x.trim()).filter(Boolean);
	if (parts.length > 1) {
		const bad = parts.filter((t) => !store.descriptors.has(t));
		if (bad.length) throw new Error(`--type ${raw}: a union names collections, and ${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} not one — ${known}`);
		return parts;
	}
	if (SCALAR_TYPES.includes(parts[0]) || store.descriptors.has(parts[0])) return parts[0];
	throw new Error(`unknown type "${parts[0]}" — ${known}`);
}

/** A boolean flag: bare or `true` turns it on; `false` or the empty value clears it. */
function flagOn(flags, key) {
	const v = flags[key];
	if (v === true || v === 'true') return true;
	if (v === false || v === 'false' || v === '') return false;
	throw new Error(`--${key} takes true or false — got "${v}"`);
}

/** A flag that takes a value; the empty value (`--x=`) clears what it names. */
function flagText(flags, key) {
	const v = flags[key];
	if (v === true) throw new Error(`--${key} takes a value (--${key}= clears it)`);
	return String(v);
}

/** A CLI default arrives as a string; which JSON value it becomes depends on the field's type. */
const coerceDefault = (type, def) => (type === 'boolean'
	? def === 'true' || def === true
	: type === 'number' || type === 'integer' ? Number(def) : def);

/** `a,b,c` → the values, trimmed. */
const optionList = (v) => (Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim()).filter(Boolean);

/**
 * One field, built from the flag vocabulary over `previous` — the field as its source declares it
 * (`{}` for a new one). Each flag owns the key it names and nothing else, so a flag that is not
 * passed leaves its key exactly as authored: `set-field --description "…"` changes the description
 * and only the description. The empty value clears a key (`--enum=`), and `false` clears a boolean.
 *
 *   --type string|markdown|…|<collection>|a,b|reference   --many   --required   --unique
 *   --enum a,b   --default-value v   --mirror-of <field>   --on-delete restrict|set-null   --soft
 *   --sensitive   --body   --description "…"
 */
export function fieldFromFlags(store, flags, previous = {}) {
	const f = structuredClone(previous ?? {});
	const has = (k) => flags[k] !== undefined;
	if (has('type')) f.type = parseType(store, flags.type);
	f.type ??= 'string';
	for (const k of ['required', 'many', 'unique', 'soft', 'sensitive', 'body']) {
		if (!has(k)) continue;
		if (flagOn(flags, k)) f[k] = true;
		else delete f[k];
	}
	if (has('enum')) {
		const v = flagText(flags, 'enum');
		if (v === '') delete f.enum;
		else {
			const values = optionList(v);
			// a decorated enum keeps each surviving value's label, icon and colour
			f.enum = f.enum && typeof f.enum === 'object' && !Array.isArray(f.enum)
				? Object.fromEntries(values.map((x) => [x, f.enum[x] ?? {}]))
				: values;
		}
	}
	if (has('mirror-of')) {
		const v = flagText(flags, 'mirror-of');
		if (v === '') delete f.mirror_of;
		else {
			const t = targetsOf(f);
			if (!Array.isArray(t) || t.length !== 1) throw new Error(`--mirror-of ${v} needs --type <collection>: the one collection whose "${v}" field points here`);
			const fk = fieldsOf(store.descriptor(t[0]))[v];
			if (!fk) throw new Error(`--mirror-of ${v}: ${t[0]} has no field "${v}"`);
			f.mirror_of = v;
			// the far side's key decides the cardinality: a unique scalar key is claimed by one record,
			// so its mirror holds one; any other key can be claimed by many
			if (!has('many')) {
				if (fk.unique && !fk.many) delete f.many;
				else f.many = true;
			}
		}
	}
	if (has('on-delete')) {
		const v = flags['on-delete'];
		if (v === '') delete f.on_delete;
		else if (v === 'restrict' || v === 'set-null') f.on_delete = v;
		else throw new Error('--on-delete takes restrict or set-null');
	}
	const def = flags['default-value'] ?? flags.default;
	if (def !== undefined) {
		if (def === true) throw new Error('--default-value takes a value (--default-value= clears it)');
		if (def === '') delete f.default;
		else f.default = f.many ? optionList(def).map((x) => coerceDefault(f.type, x)) : coerceDefault(f.type, def);
	}
	if (has('description')) {
		const v = flagText(flags, 'description');
		if (v === '') delete f.description;
		else f.description = v;
	}
	// what a flag can be held to before the gate compile, so the refusal names the flag
	if (f.body && f.type !== 'markdown') throw new Error(`--body marks the field a record's prose lands in, so it is --type markdown (got ${f.type})`);
	if (has('enum') && f.enum !== undefined && f.type !== 'string') throw new Error(`--enum belongs to --type string (got ${Array.isArray(f.type) ? f.type.join(',') : f.type})`);
	if (has('on-delete') && f.on_delete !== undefined && !targetsOf(f)) throw new Error(`--on-delete belongs to a reference — give --type <collection>`);
	if (has('soft') && f.soft && !targetsOf(f)) throw new Error(`--soft belongs to a reference — give --type <collection>`);
	return orderField(previous ?? {}, f);
}

/**
 * The field's keys in writing order: the keys the source already had stay where its author put
 * them, and a new key goes in at its canonical place among them — so `set-field --unique` adds one
 * line and moves none.
 */
function orderField(previous, next) {
	const rank = (k) => { const i = FIELD_KEY_ORDER.indexOf(k); return i < 0 ? FIELD_KEY_ORDER.length : i; };
	const keys = Object.keys(previous).filter((k) => k in next);
	for (const k of Object.keys(next).filter((x) => !keys.includes(x)).sort((a, b) => rank(a) - rank(b))) {
		const at = keys.findIndex((x) => rank(x) > rank(k));
		keys.splice(at < 0 ? keys.length : at, 0, k);
	}
	return Object.fromEntries(keys.map((k) => [k, next[k]]));
}

/**
 * The `fields` map with `name` set. A NEW field lands before the body field, because field order is
 * form order and a record's prose belongs last; an EXISTING one keeps its place, because `set-field`
 * must not reorder a descriptor its author ordered by hand.
 */
function placeField(fields, name, field) {
	if (fields[name] !== undefined) return { ...fields, [name]: field };
	const body = Object.keys(fields).find((k) => fields[k]?.body === true);
	if (body === undefined) return { ...fields, [name]: field };
	const out = {};
	for (const [k, v] of Object.entries(fields)) {
		if (k === body) out[name] = field;
		out[k] = v;
	}
	return out;
}

/** Deep value equality as a string, key ORDER ignored — "is this already exactly that field" must
 *  not turn on whether the keys came back in authored order or in flag order. */
function canonical(v) {
	if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
	if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
	return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

/**
 * THE SOURCE THAT DECLARES AN EXISTING FIELD — the one `set-field` and `rm-field` edit.
 *
 * The base when it declares it; the one overlay that does when the base does not (a field another
 * module added); `--module` to choose between a base and an overlay that both do. A field a mixin
 * contributes is refused, because the mixin is shared by every collection listing it, and an
 * injected field has no source at all.
 */
function declaringSource(ws, store, collection, fieldName, moduleId, verb) {
	if (INJECTED.has(fieldName)) throw new Error(`"${fieldName}" is injected by the engine into every collection — no source declares it, so ${verb} cannot edit it`);
	if (!fieldsOf(store.descriptor(collection))[fieldName]) throw new Error(`no field "${fieldName}" on ${collection}`);
	if (moduleId !== undefined && moduleId !== null && moduleId !== '') {
		return collectionSourceFile(ws, store, collection, moduleId, { subject: `${collection}.${fieldName}`, allowNew: verb === 'set-field' });
	}
	const { base, overlays } = baseDescriptorSource(ws, collection);
	const declares = (rel) => !!rel && readYaml(path.join(ws.root, rel))?.fields?.[fieldName] !== undefined;
	if (declares(base) && !IN_NODE_MODULES(base)) return { file: path.join(ws.root, base), overlay: false };
	const own = overlays.filter(declares);
	if (own.length > 1) throw new Error(`${collection}.${fieldName} is declared by ${own.join(', ')} — say which with --module <m>`);
	if (own.length === 1 && !IN_NODE_MODULES(own[0])) return { file: path.join(ws.root, own[0]), overlay: true };
	const mixin = mixinDeclaring(ws, store, collection, fieldName);
	if (mixin) throw new Error(`${collection}.${fieldName} comes from mixin "${mixin.id}" (${mixin.rel}), which every collection listing it shares — edit the mixin, or declare the field on ${collection} itself`);
	if (verb === 'rm-field') throw new Error(`${collection}.${fieldName} is declared by ${base ?? own[0] ?? 'a source this workspace cannot rewrite'}, which ships from node_modules — an overlay can override a field there, never remove it`);
	// declared only where `npm install` would erase a write: an override in an overlay is the remedy
	return collectionSourceFile(ws, store, collection, undefined, { subject: `${collection}.${fieldName}` });
}

/** What an override in a NEW overlay starts from: the shape it overrides, so the overlay validates
 *  on its own — every other key is inherited from the base. */
const overrideSeed = (merged) => ({ type: merged.type, ...(merged.many && { many: true }) });

export function addField(ws, store, collection, { name: fieldName, field, moduleId }) {
	if (!fieldName || fieldName === true) throw new Error('missing --name <field>');
	if (INJECTED.has(fieldName)) throw new Error(`"${fieldName}" is injected by the engine into every collection — pick another name`);
	const merged = fieldsOf(store.descriptor(collection))[fieldName];
	const target = collectionSourceFile(ws, store, collection, moduleId, { allowNew: true, subject: `${collection}.${fieldName}` });
	// ⚠ On an OVERLAY, a field the base already declares is an OVERRIDE, not a duplicate — that is
	// what an overlay is for. Only a write to the base, or to an overlay that already declares it,
	// can collide.
	if (merged !== undefined) {
		const mixin = mixinDeclaring(ws, store, collection, fieldName);
		const inTarget = readYaml(target.file)?.fields?.[fieldName] !== undefined;
		if (!target.overlay || inTarget || mixin) {
			throw new Error(`field "${fieldName}" already exists on ${collection}${mixin ? ` (from mixin "${mixin.id}")` : ''} — change it with dreamteamer set-field ${collection} --name ${fieldName} …`);
		}
	}
	return upsertField(ws, store, collection, fieldName, field, `add-field ${fieldName}`, target);
}

/**
 * Change one field. `flags` is the flag vocabulary (`fieldFromFlags`), applied over the field as its
 * source declares it; `field` is a whole v2 field from a surface, which replaces it.
 */
export function updateField(ws, store, collection, fieldName, { flags = {}, field, moduleId } = {}) {
	const target = declaringSource(ws, store, collection, fieldName, moduleId, 'set-field');
	const authored = readYaml(target.file)?.fields?.[fieldName];
	const previous = authored ?? overrideSeed(fieldsOf(store.descriptor(collection))[fieldName]);
	return upsertField(ws, store, collection, fieldName, field ?? fieldFromFlags(store, flags, previous), `set-field ${fieldName}`, target);
}

function upsertField(ws, store, collection, fieldName, field, verb, { file: dest, overlay }) {
	if (field == null || typeof field !== 'object' || Array.isArray(field)) {
		throw new Error(`field "${fieldName}" must be a map of field keys (got ${Array.isArray(field) ? 'a list' : typeof field}) — nothing was written.`);
	}
	// The BYTES, not just the parse: `dump` cannot round-trip a comment, and a collection descriptor is
	// where a module writes down why the collection exists (see writeSource).
	const previousText = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
	let doc;
	if (previousText !== null) doc = load(previousText);
	// Reached when no source this workspace may rewrite declares the collection — an npm-shipped or
	// engine-contributed one. An overlay in the workspace module is the remedy, and compile still
	// requires that module to declare the base's in its dependencies.
	else if (overlay) doc = { name: collection, overlay: true, fields: {} };
	else throw new Error(`${path.relative(ws.root, dest)} is named by the compiled manifest but is not on disk — run \`dreamteamer compile\` and re-run.`);
	// AN IDEMPOTENT WRITE IS A SUCCESS — a re-run of an "apply my schema" script, or a retry after a
	// partial failure, asks for what is already there. Say so plainly and stop, without a commit; but
	// still through the compile, so a broken workspace fails exactly as the gate fails it.
	const already = doc.fields?.[fieldName];
	if (already !== undefined && canonical(already) === canonical(field)) {
		compileGated(ws, store);
		return { collection, field: fieldName, file: dest, overlay, value: already, unchanged: true };
	}
	const gate = writeGated(ws, store, [dest], `dreamteamer: ${collection} ${verb}`, () => {
		doc.fields = placeField(doc.fields ?? {}, fieldName, field);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, writeSource(previousText, doc));
	});
	return { collection, field: fieldName, file: dest, overlay, value: field, commits: gate.commits };
}

/**
 * Clear one field's values from every record of a collection — the other half of removing it.
 *
 * A removed field whose values stay in the files leaves the collection READABLE AND UNWRITABLE: the
 * key is now an unknown field, `check` reports it and the store refuses the next write to that
 * record. So the op that creates the staleness cleans it up, in the same write and the same commit.
 * A mirror is a field like any other here: its values live in this collection's records.
 *
 * ⚠ THIS DELETES DATA, deliberately: removing a field is an explicit destructive schema act, it runs
 * inside the gate's commit, so the previous values are one `git show HEAD~1` away, and the COUNT is
 * returned and printed — a silent deletion and a reported one are different acts.
 *
 * ⚠ THE BODY FIELD needs none of this. With the field gone the descriptor names no body, so the
 * prose is not parsed into `fields` at all and stays in the file as Markdown no field claims.
 */
function clearFieldValues(store, collection, fieldName) {
	const d = store.descriptors.get(collection);
	// a binary record has no serialised fields, and a compiled-source collection is a build artifact
	if (!d || !store.canRewrite(collection)) return { files: [], undo: () => {}, records: 0 };
	const bf = bodyFieldOf(d);
	const files = [], undos = [];
	for (const [, file] of store.ids(collection)) {
		let fields;
		try { fields = parseRecord(file, d, bf); } catch { continue; } // `check` reports a bad record
		if (!(fieldName in fields)) continue;
		const previous = fs.readFileSync(file, 'utf8');
		delete fields[fieldName];
		atomicWrite(file, serialize(d, fields, previous));
		files.push(file);
		undos.push(() => atomicWrite(file, previous));
	}
	return { files, undo: () => { for (const u of [...undos].reverse()) u(); }, records: files.length };
}

/** The positions in the edited source that are the field's OWN presentation — removing the field is
 *  an explicit act, and pruning these is what it means. Everything else naming it is refused. */
const PRUNED_WITH_THE_FIELD = /^display\.(list\.(columns|sort|options\.[a-z_]+)|record\.(badge|color_by)|form\.sections\[\d+\])$/;

/** Prune the field's own presentation from one parsed source, dropping what the prune empties. */
function pruneFieldPresentation(doc, fieldName) {
	const display = doc.display;
	if (!display || typeof display !== 'object') return;
	const list = display.list;
	if (list) {
		if (Array.isArray(list.columns)) {
			list.columns = list.columns.filter((c) => c !== fieldName);
			if (!list.columns.length) delete list.columns;
		}
		if (typeof list.sort === 'string' && list.sort.replace(/^-/, '') === fieldName) delete list.sort;
		if (list.options && typeof list.options === 'object') {
			for (const k of OPTION_FIELD_KEYS) if (list.options[k] === fieldName) delete list.options[k];
			for (const k of OPTION_FIELD_LISTS) {
				if (!Array.isArray(list.options[k])) continue;
				list.options[k] = list.options[k].filter((c) => c !== fieldName);
				if (!list.options[k].length) delete list.options[k];
			}
			if (!Object.keys(list.options).length) delete list.options;
		}
	}
	for (const k of ['badge', 'color_by']) if (display.record?.[k] === fieldName) delete display.record[k];
	if (Array.isArray(display.form?.sections)) {
		display.form.sections = display.form.sections
			.map((sec) => (Array.isArray(sec?.fields) ? { ...sec, fields: sec.fields.filter((f) => f !== fieldName) } : sec))
			.filter((sec) => !Array.isArray(sec?.fields) || sec.fields.length);
		if (!display.form.sections.length) delete display.form.sections;
	}
	// a block the prune left empty is a statement nobody made
	for (const b of Object.keys(display)) if (display[b] && typeof display[b] === 'object' && !Object.keys(display[b]).length) delete display[b];
	if (!Object.keys(display).length) delete doc.display;
}

/** What `rm-field` would do, counted without writing: the values it clears, the presentation it
 *  prunes, and every position elsewhere that still names the field — which it refuses on. */
export function removeFieldPlan(ws, store, collection, fieldName, { moduleId } = {}) {
	const { file } = declaringSource(ws, store, collection, fieldName, moduleId, 'rm-field');
	const rel = path.relative(ws.root, file);
	if (readYaml(file)?.fields?.[fieldName] === undefined) throw new Error(`${rel} does not declare ${collection}.${fieldName} — it is declared by ${declaringModules(ws, store, collection).join(', ')}; drop --module, or name the module whose source declares it`);
	// the same walk a rename makes, to a name nothing can hold: every position it reaches names the field
	const { positions } = fieldRenameWalk(ws, store, collection, fieldName, `${fieldName}\u0000`, { records: false });
	const own = (p) => p.rel === rel && (p.at === `fields.${fieldName}` || PRUNED_WITH_THE_FIELD.test(p.at));
	// another source declaring the field keeps it alive — an override removed from an overlay, say —
	// so nothing naming it dangles and its values stay
	const survives = positions.some((p) => p.rel !== rel && p.at === `fields.${fieldName}`);
	const blocking = survives ? [] : positions.filter((p) => !own(p)).map((p) => ({ ...p, fixed: false, why: p.why ?? 'it would name a field that no longer exists' }));
	const d = store.descriptor(collection);
	let cleared = 0;
	if (!survives && store.canRewrite(collection)) {
		const bf = bodyFieldOf(d);
		for (const [, f] of store.ids(collection)) {
			try { if (fieldName in parseRecord(f, d, bf)) cleared++; } catch { /* `check` reports it */ }
		}
	}
	return {
		collection, field: fieldName, file, positions: positions.filter(own), blocking,
		records: cleared, refs: 0, descriptors: 1, cleared,
	};
}

export function removeField(ws, store, collection, fieldName, { moduleId, dryRun = false } = {}) {
	const plan = removeFieldPlan(ws, store, collection, fieldName, { moduleId });
	if (dryRun) return { ...plan, dryRun: true };
	// ⚠ A NAME ANOTHER POSITION STILL CARRIES IS REFUSED, not left dangling: compile validates every
	// one of them (rule 6), and a template, a constraint, a mirror or a view naming a field that is
	// gone is a decision about what it should say instead — which is the operator's to make.
	refusePositions(`rm-field ${collection} --name ${fieldName}`, plan.blocking);
	const dest = plan.file;
	const previousText = fs.readFileSync(dest, 'utf8');
	const doc = load(previousText);
	const out = writeGated(ws, store, [dest], `dreamteamer: ${collection} rm-field ${fieldName}`, () => {
		delete doc.fields[fieldName];
		pruneFieldPresentation(doc, fieldName);
		// an overlay whose last field is gone adds nothing to the merge — removing its last field
		// removes the file
		if (doc.overlay === true && !Object.keys(doc.fields).length && Object.keys(doc).every((k) => ['name', 'overlay', 'fields'].includes(k))) fs.rmSync(dest);
		else fs.writeFileSync(dest, writeSource(previousText, doc));
	}, () => {
		const after = new Store(ws); // the runtime as the gate compile just left it
		if (fieldsOf(after.descriptor(collection))[fieldName]) return {};
		const own = clearFieldValues(after, collection, fieldName);
		return { files: own.files, undo: own.undo, cleared: own.records };
		// ⚠ THE ONE OP THAT MAY LOSE A COMMENT: the comment above a field explains THAT field, so
		// removing the field takes it, which is the outcome asked for.
	}, { commentsMayDecrease: true });
	return { collection, removed: fieldName, cleared: out.cleared, commits: out.commits };
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
export function saveUiView(ws, store, { id, view, moduleId }) {
	if (!id || !/^[a-z0-9][a-z0-9-/]*$/.test(id)) throw new Error(`invalid ui-view id "${id}" — lowercase slug required`);
	// §5: `add` on a system collection takes `--module`. It used to be dropped by the parser and then
	// assigned into the VIEW as a field called `module` — `dt add ui-views … --module core` wrote
	// `module: core` into the yaml, compiled clean, and self-committed a workspace only `dt check`
	// would later object to. An explicit target module resolves the destination; without one the
	// manifest answers (an existing view is edited where it lives), and the workspace module is the
	// fallback for a new one.
	const { file: dest, shipped } = moduleId
		? { file: path.join(kindDir(path.join(ws.root, moduleRecord(store, moduleId).fields.path), 'ui-views'), `${id}.ui-view.yaml`), shipped: null }
		: uiViewSourceFile(ws, id);
	if (shipped && /(^|\/)node_modules\//.test(shipped))
		throw new Error(`ui-view "${id}" is shipped by an installed package (${shipped}) — a write there is erased by the next npm install.\n  save it under a different name, or disable it (dreamteamer.disable) and re-create it.`);
	const existed = fs.existsSync(dest);
	// `compiled` is compile's: a view read back from the runtime carries it, and a source never does
	view = Object.fromEntries(Object.entries(view).filter(([k]) => k !== 'compiled'));
	// A module source is where this project writes down WHY a view exists; `dump` cannot keep that.
	const previous = existed ? fs.readFileSync(dest, 'utf8') : null;
	// ⚠ opted OUT of the comment invariant, on the same rule `rm-field` is: this write REPLACES
	// the view, so a key the caller omits is deliberately gone (see the `filter:` case) and the comment
	// explaining that key goes with it. Every key that SURVIVES keeps its comments, which is what the
	// round-trip buys and what the old `dump` could not do.
	const gate = writeGated(ws, store, [dest], `dreamteamer: ui-views ${existed ? 'update' : 'add'} ${id}`, () => {
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, writeSource(previous, view));
	}, undefined, { commentsMayDecrease: true });
	return { id, file: dest, updated: existed, commits: gate.commits, unchanged: gate.unchanged };
}

export function removeUiView(ws, store, id) {
	// Same source resolution as the save above — an inline module's view is under this repo's git
	// history like everything else, so deleting it is one revertable commit. Refusing it while
	// ALLOWING a save to the same file would be an asymmetry with nothing behind it.
	const { file: dest, shipped } = uiViewSourceFile(ws, id);
	if (shipped && /(^|\/)node_modules\//.test(shipped))
		throw new Error(`ui-view "${id}" is shipped by an installed package (${shipped}) — removing the file would be undone by the next npm install.\n  disable it instead: add "ui-views/${id}" to dreamteamer.disable in package.json.`);
	if (!fs.existsSync(dest)) throw new Error(`ui-view "${id}" does not exist`);
	const gate = writeGated(ws, store, [dest], `dreamteamer: ui-views rm ${id}`, () => fs.rmSync(dest), undefined, { commentsMayDecrease: true });
	return { removed: id, commits: gate.commits };
}

// ---- the identity entities: skills, agents, commands, command-bindings, mixins ----------------
// §3.1's last row. These are FLAT at a module root and stay flat (decision 274) — their ids are
// single segments, and namespacing them was cut with the wave that considered it.
//
// `add` is a SCAFFOLD for skills only, and refused with the path for the rest. That asymmetry is not
// arbitrary: a skill's minimum-that-compiles is two frontmatter keys and an empty body, which a verb
// can write honestly. An agent, a command, a binding and a mixin are all PROSE or PREDICATES —
// the value is entirely in what a human writes, and a verb that scaffolds one produces a file whose
// only content is the fact that a verb made it.

/** kind → {suffix, folder} — one table, because five verbs read it and a sixth spelling of "where
 *  does a command live" is how a kind the engine stopped knowing sat in a module for two days
 *  (decision 156). */
const ENTITY_SHAPE = {
	skills: { suffix: 'SKILL.md', folder: true },
	agents: { suffix: '.agent.md', folder: false },
	commands: { suffix: '.command.md', folder: false },
	'command-bindings': { suffix: '.command-binding.yaml', folder: false },
	mixins: { suffix: '.mixin.yaml', folder: false },
};

/** The shape of one kind — the table above, else DERIVED from the compiled descriptor, which is how
 *  a kind an extension contributes (`proofs`) gets `rm · rename · set` without this file naming it:
 *  `storage.suffix` + the codec's extension, one file per id. */
function entityShape(ws, kind) {
	if (ENTITY_SHAPE[kind]) return ENTITY_SHAPE[kind];
	const d = loadDescriptors(ws.root).get(kind);
	const storage = storageOf(d);
	if (!isRuntime(d) || !storage.suffix) throw new Error(`"${kind}" is not an entity kind this workspace compiles`);
	return { suffix: `.${storage.suffix}${EXT[storage.format] ?? '.md'}`, folder: storage.shape === 'folder' };
}

/** The source file (or folder) ONE entity is compiled from, asked of the manifest — the same
 *  question `uiViewSourceFile` asks, for the five other kinds. */
function entitySource(ws, kind, id) {
	const shape = entityShape(ws, kind);
	const key = shape.folder ? `${kind}/${id}/SKILL.md` : `${kind}/${id}${shape.suffix}`;
	const src = readManifest(ws.root)?.entries?.[key]?.sources?.[0];
	const shipped = typeof src === 'string' ? src : src?.path;
	if (!shipped) return { file: null, dir: null, shipped: null };
	const file = path.join(ws.root, shipped);
	return { file, dir: shape.folder ? path.dirname(file) : file, shipped };
}

/** Refuse a write into an installed package, with `disable` as the remedy — the message every other
 *  op in this file already gives, in one place. */
function refuseNpmEntity(kind, id, shipped) {
	if (!shipped || !IN_NODE_MODULES(shipped)) return;
	throw new Error(`${kind.replace(/s$/, '')} "${id}" is shipped by an installed package (${shipped}) — a write there is erased by the next \`npm install\`.\n  disable it instead: add "${kind}/${id}" to dreamteamer.disable in package.json.`);
}

const ENTITY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function createSkill(ws, store, { name, description, moduleId }) {
	if (!name || name === true) throw new Error('missing skill name — dreamteamer add skills --name <id> --description "…"');
	if (!ENTITY_ID.test(name)) throw new Error(`invalid skill id "${name}" — lowercase alphanumeric with single hyphens (it is a folder name and the frontmatter \`name\` at once).`);
	if (typeof description !== 'string' || !description.trim()) {
		// ⚠ REQUIRED, not defaulted. claude-code discovers skills natively and shows the description
		// as the trigger; the orientation block indexes it for every other harness. A skill with no
		// description is loadable by nobody and shows up as a bare id in the one place an agent looks.
		throw new Error('--description is required: it is the sentence that says WHEN to load this skill, and it is all any harness shows. An undescribed skill is undiscoverable.');
	}
	if (store.descriptors.has('skills') && store.ids('skills').has(name)) {
		throw new Error(`skill "${name}" already exists — dt get skills/${name}`);
	}
	const root = moduleId ? path.join(ws.root, moduleRecord(store, moduleId).fields.path) : null;
	if (root && IN_NODE_MODULES(path.relative(ws.root, root))) {
		throw new Error(`module "${moduleId}" ships from node_modules — a write there is erased by the next \`npm install\`.`);
	}
	// ⚠ THE MODULE ROOT IS RETURNED, not left to the caller to slice back out of `file`. The caller
	// prints a path under it (the `no proof yet` nudge), and deriving that by cutting at `/skills/`
	// is wrong in both layouts this function already handles: the ROOT layout writes
	// `skills/<id>/SKILL.md` with no module segment at all, and the pre-flatten one writes
	// `system/skills/…`. Here the answer is known exactly, in one line.
	const wm = ws.pkg.dreamteamer?.workspace_module;
	const modRoot = root ?? (wm ? path.join(ws.root, 'modules', wm) : ws.root);
	const dir = path.join(root ? kindDir(root, 'skills') : workspaceSystemDir(ws, 'skills'), name);
	const file = path.join(dir, 'SKILL.md');
	if (fs.existsSync(file)) throw new Error(`${path.relative(ws.root, file)} already exists`);
	// THE MINIMUM THAT COMPILES, and nothing more: two frontmatter keys and an empty body. A
	// scaffold that guesses at sections is a file whose only content is that a verb made it.
	const text = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n`;
	const out = gatedTreeOp(ws, store, {
		subject: `dreamteamer: skills add ${name}`,
		paths: [path.relative(ws.root, file)],
		mutate: () => {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(file, text);
		},
		undo: () => fs.rmSync(dir, { recursive: true, force: true }),
	});
	return { id: name, file, moduleRoot: path.relative(ws.root, modRoot) || '.', commits: out.commits };
}

/** `add` on a kind nobody can scaffold honestly — refused WITH THE PATH, because "hand-authored"
 *  without the filename is a refusal the reader has to go research. */
export function refuseHandAuthored(ws, store, kind, id, moduleId) {
	const shape = entityShape(ws, kind);
	const root = moduleId ? moduleRecord(store, moduleId).fields.path : path.join('modules', ws.pkg.dreamteamer?.workspace_module ?? 'default');
	const where = path.join(root, kind, `${id || '<id>'}${shape.suffix}`);
	const one = kind.replace(/s$/, '');
	throw new Error(`${/^[aeiou]/.test(one) ? 'an' : 'a'} ${one} is hand-authored — its whole value is what you write in it, and a scaffold would produce a file whose only content is that a verb made it.\n  write ${where}, then run \`dreamteamer compile\`.\n  edit an existing one with: dreamteamer set ${kind}/<id> <key>=<value>`);
}

export function removeEntity(ws, store, kind, id) {
	const { dir, shipped } = entitySource(ws, kind, id);
	if (!shipped) throw new Error(`${kind.replace(/s$/, '')} "${id}" does not exist — dt list ${kind}`);
	refuseNpmEntity(kind, id, shipped);
	// ⚠ STASH, DO NOT DELETE, UNTIL THE COMMIT LANDS — `gatedTreeOp`'s `undo` has to be able to put a
	// whole folder back, and a `rmSync` cannot be undone. Same reasoning as `removeModule`.
	const stash = path.join(ws.root, '.dreamteamer', `.rm-${kind}-${id}`);
	fs.rmSync(stash, { recursive: true, force: true });
	try {
		const out = gatedTreeOp(ws, store, {
			subject: `dreamteamer: ${kind} rm ${id}`,
			paths: [path.relative(ws.root, dir)],
			mutate: () => {
				fs.mkdirSync(path.dirname(stash), { recursive: true });
				fs.renameSync(dir, stash);
			},
			undo: () => { if (fs.existsSync(stash)) fs.renameSync(stash, dir); },
		});
		return { removed: id, file: dir, commits: out.commits };
	} finally {
		fs.rmSync(stash, { recursive: true, force: true });
	}
}

export function renameEntity(ws, store, kind, oldId, newId) {
	if (!newId || newId === true) throw new Error(`missing new id — dreamteamer rename ${kind}/${oldId} <new-id>`);
	if (oldId === newId) return { renamed: false, id: newId };
	if (!ENTITY_ID.test(newId)) throw new Error(`invalid ${kind.replace(/s$/, '')} id "${newId}" — lowercase alphanumeric with single hyphens.`);
	const shape = entityShape(ws, kind);
	const { dir, file, shipped } = entitySource(ws, kind, oldId);
	if (!shipped) throw new Error(`${kind.replace(/s$/, '')} "${oldId}" does not exist — dt list ${kind}`);
	refuseNpmEntity(kind, oldId, shipped);
	const newDir = shape.folder
		? path.join(path.dirname(dir), newId)
		: path.join(path.dirname(file), `${newId}${shape.suffix}`);
	if (fs.existsSync(newDir)) throw new Error(`${path.relative(ws.root, newDir)} already exists`);
	const entityFile = shape.folder ? path.join(newDir, 'SKILL.md') : newDir;
	const isYaml = shape.suffix.endsWith('.yaml');
	let before = null;
	const out = gatedTreeOp(ws, store, {
		subject: `dreamteamer: ${kind} rename ${oldId} → ${newId}`,
		paths: [path.relative(ws.root, shape.folder ? dir : file), path.relative(ws.root, newDir)],
		mutate: () => {
			fs.renameSync(shape.folder ? dir : file, newDir);
			// ⚠ THE FRONTMATTER `name` IS PART OF THE ID. compile reads the FILENAME for the entity id
			// and the frontmatter for what the harness shows, and letting them disagree is how a skill
			// answers to one name in the tree and another in the session that loads it. A YAML entity
			// (a binding, a template) carries no `name` key, so there is nothing to move.
			before = fs.readFileSync(entityFile, 'utf8');
			if (!isYaml) fs.writeFileSync(entityFile, setFrontmatterKey(before, 'name', newId));
		},
		undo: () => {
			if (before !== null && fs.existsSync(entityFile)) fs.writeFileSync(entityFile, before);
			if (fs.existsSync(newDir)) fs.renameSync(newDir, shape.folder ? dir : file);
		},
	});
	return { renamed: true, id: newId, commits: out.commits };
}

export function setEntityFrontmatter(ws, store, kind, id, changes) {
	const shape = entityShape(ws, kind);
	const { dir, file, shipped } = entitySource(ws, kind, id);
	if (!shipped) throw new Error(`${kind.replace(/s$/, '')} "${id}" does not exist — dt list ${kind}`);
	refuseNpmEntity(kind, id, shipped);
	// ⚠ THE DESCRIPTOR IS THE AUTHORITY, and the engine was disagreeing with itself: `dt set
	// skills/<id> descripton="oops"` wrote the typo, compiled, SELF-COMMITTED — and then `dt check`
	// failed on the very workspace the self-commit exists to keep valid, because the `skills`
	// descriptor declares a closed set of properties and check validates against it. "Frontmatter is
	// an open document" was the wrong half to believe: if a key is not in the descriptor, `check`
	// will reject it, so `set` refuses it first. Its two siblings already read this way
	// (`setCollectionScalars`, `setModule`), and a body field is not settable from the CLI at all.
	const props = fieldsOf(store.descriptors.get(kind));
	const settable = (k) => props[k] && !props[k].body && !props[k].derived && !props[k].virtual;
	const unknown = Object.keys(changes).find((k) => !settable(k));
	if (unknown) throw new Error(`"${unknown}" is not a settable key of ${kind} — declared: ${Object.keys(props).filter(settable).join(', ')}. \`dreamteamer check\` rejects anything else, so this is refused before it is committed.`);
	const target = shape.folder ? path.join(dir, 'SKILL.md') : file;
	// A YAML source (a binding, a template) is a whole document; a markdown one has frontmatter and
	// prose. `writeSource` round-trips both — the difference is only which text it is handed.
	const isYaml = shape.suffix.endsWith('.yaml');
	const previousText = fs.readFileSync(target, 'utf8');
	const changed = [];
	const gate = writeGated(ws, store, [target], `dreamteamer: ${kind} set ${id} ${Object.keys(changes).join(' ')}`, () => {
		if (isYaml) {
			const doc = load(previousText) ?? {};
			for (const [k, v] of Object.entries(changes)) {
				if (v === '' || v === null) delete doc[k];
				else doc[k] = v;
				changed.push(k);
			}
			fs.writeFileSync(target, writeSource(previousText, doc));
		} else {
			let text = previousText;
			for (const [k, v] of Object.entries(changes)) {
				text = setFrontmatterKey(text, k, v === '' ? null : v);
				changed.push(k);
			}
			fs.writeFileSync(target, text);
		}
	}, undefined, { commentsMayDecrease: true });
	return { id, file: target, changed, commits: gate.commits, unchanged: gate.unchanged };
}

/**
 * One frontmatter key, set (or removed with `null`), with the BODY untouched.
 *
 * ⚠ Round-tripped through `writeSource` over the frontmatter block ALONE, and the body re-attached
 * verbatim. Re-dumping a whole markdown file is how a skill's prose gets re-wrapped by a verb that
 * was asked to change one word of its description — and a skill's prose is the entire artifact.
 */
function setFrontmatterKey(text, key, value) {
	const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n[\s\S]*)?$/.exec(text);
	if (!m) throw new Error('no YAML frontmatter — a markdown entity starts with a `---` block, and this file does not.');
	const doc = load(m[1]) ?? {};
	if (value === null) delete doc[key];
	else doc[key] = value;
	const front = writeSource(m[1], doc).replace(/\n+$/, '');
	return `---\n${front}\n---${m[2] ?? '\n'}`;
}
