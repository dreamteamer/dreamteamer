// schema operations — source-writing mutations shared by the CLI meta verbs and the
// server's schema endpoints. the contract (audit finding 11, clean-room bug 2): an op
// writes sources, proves them with a REAL compile, and only then commits — an
// uncompilable source can never land in history. the successful gate compile also
// leaves the runtime fresh, which kills the add-field-right-after-collections-add
// papercut (review finding 7): schema ops ARE explicit compiles.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { load, dump } from './yaml.js';
import { compile, kindDir, titleCase } from './compile.js';
import { readManifest, runtimeKindDir } from './runtime.js';
import { normalizeNamespaces, namespaceOf, baseNameOf, qualify, defaultStoragePath } from './namespace.js';
import { refTargetsOf } from './ref.js';

// Same rule as store.js: a git failure we CATCH must not also print git's own error on top of the
// clean message we throw. stdout stays piped because some callers read it.
const GIT_QUIET = ['ignore', 'pipe', 'ignore'];
import { walk, idFromRecordPath, parseRecord } from './records.js';
import { Store, bodyField, serialize, atomicWrite } from './store.js';

// ---- the gate -------------------------------------------------------------------

function writeGated(ws, store, files, subject, mutate, after) {
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
		try {
			compile(ws); // dry-run that doubles as the materialization — throws CompileError on bad sources
		} catch (e) {
			restore();
			try { compile(ws); } catch { /* runtime was already broken before this op */ }
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
		try {
			execFileSync('git', ['add', '--', ...rels], { cwd: ws.root, stdio: GIT_QUIET });
			execFileSync('git', ['commit', '--quiet', '-m', subject, '--', ...rels], { cwd: ws.root, stdio: GIT_QUIET });
		} catch (e) {
			try { execFileSync('git', ['reset', '--quiet', '--', ...rels], { cwd: ws.root, stdio: GIT_QUIET }); } catch { /* nothing staged */ }
			extra.undo();
			restore();
			try { compile(ws); } catch { /* pre-op sources were compilable */ }
			throw new Error(`git commit failed — the schema change was rolled back, nothing was changed. (${e.message.split('\n')[0]})`);
		}
		// The hook's own report, for the caller to print: what a source change did to DATA is not
		// visible in the file list, and a silent data change is a different act from a reported one.
		return extra;
	});
}

/** The compile half of the gate, under the same lock, with no source write and no commit — for a
 *  schema op that turns out to ask for what is already on disk. Materializing `.dreamteamer/` is the
 *  point rather than a side effect: the caller is about to report success, and success has always
 *  meant "the compiled runtime is valid and current". */
function compileGated(ws, store) {
	return store.withWriteLock(() => compile(ws));
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
 * Set one scalar in a YAML document TEXTUALLY, so comments and key order survive.
 *
 * This exists because `load` → mutate → `dump` is lossy in the one way that matters here: it drops
 * every comment. That is fine for a generated artifact and wrong for a module SOURCE, which is where
 * this project writes down why a collection exists. Only `renameCollection` uses it, and only for the
 * three scalars a rename changes; anything more ambitious belongs in a real round-trip YAML library,
 * not in a regex.
 *
 * Handles both spellings the descriptors actually use — a top-level key, a nested block mapping, and
 * the inline `storage: { path: x, suffix: y }` flow form. Callers MUST re-parse and assert, because a
 * shape not covered here fails by changing nothing rather than by throwing.
 */
function setScalar(text, keyPath, value) {
	const [head, child] = keyPath;
	if (!child) return text.replace(new RegExp(`^${head}:.*$`, 'm'), `${head}: ${value}`);

	// inline flow mapping: `storage: { path: data/x, suffix: y }`
	const flow = new RegExp(`^${head}:\\s*\\{([^}]*)\\}\\s*$`, 'm').exec(text);
	if (flow) {
		let body = flow[1];
		body = new RegExp(`\\b${child}:\\s*[^,}]+`).test(body)
			? body.replace(new RegExp(`(\\b${child}:\\s*)[^,}]+`), `$1${value}`)
			: `${body.trimEnd()}, ${child}: ${value}`;
		return text.slice(0, flow.index) + `${head}: {${body}}` + text.slice(flow.index + flow[0].length);
	}

	// block mapping: `storage:\n  path: data/x`
	const block = new RegExp(`^${head}:\\n(?:[ \\t]+.*\\n)*?[ \\t]+${child}:.*$`, 'm').exec(text);
	if (block) {
		return text.slice(0, block.index)
			+ block[0].replace(new RegExp(`([ \\t]+${child}:).*$`, 'm'), `$1 ${value}`)
			+ text.slice(block.index + block[0].length);
	}

	// the key is absent under an existing block — insert it directly after the parent
	const parent = new RegExp(`^${head}:\\s*$`, 'm').exec(text);
	if (parent) {
		const at = parent.index + parent[0].length + 1;
		return text.slice(0, at) + `  ${child}: ${value}\n` + text.slice(at);
	}
	return text;
}

// ---- ops ------------------------------------------------------------------------

export function createCollection(ws, store, { name, template, namespace }) {
	if (!name) throw new Error('missing collection name');
	// `--namespace health --name doctors` and `--name health/doctors` are the SAME collection, because
	// the qualified name IS the identity everywhere else in the engine. Accepting both keeps the CLI
	// honest about that rather than making the operator learn which spelling a verb wants.
	const declared = normalizeNamespaces(ws.pkg.dreamteamer?.namespaces);
	const qualified = namespace ? qualify(namespace, name) : name;
	const ns = namespaceOf(qualified, declared);
	if (qualified.includes('/') && !ns) {
		throw new Error(`namespace "${qualified.slice(0, qualified.lastIndexOf('/'))}" is not declared — add it to dreamteamer.namespaces in package.json first, or the collection will not compile.`);
	}
	if (store.descriptors.has(qualified)) throw new Error(`collection "${qualified}" already exists`);
	// NESTED, mirroring where compile puts it in the runtime: `collections/health/doctors.collection.yaml`.
	// compile enumerates this kind recursively for exactly this reason — and `upsertField` derives the
	// same path from the same name, which is what keeps a later `add-field` editing the base descriptor
	// instead of quietly creating an overlay beside it.
	const dest = path.join(workspaceSystemDir(ws, 'collections'), `${qualified}.collection.yaml`);
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
		path: defaultStoragePath(qualified, declared, ws.pkg.dreamteamer?.['data-path'] ?? 'data'),
		codec: 'md', shape: 'file',
		...descriptor.storage,
		// the SUFFIX comes off the bare name — `health/doctors` records are `<id>.doctor.md`, not
		// `<id>.health/doctor.md`
		suffix: descriptor.storage?.suffix ?? singular(baseNameOf(qualified, declared)),
	};
	writeGated(ws, store, [dest], `dreamteamer: collections add ${qualified}`, () => {
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, dump(descriptor));
	});
	return { file: dest, descriptor };
}

export function removeCollection(ws, store, name, { force = false } = {}) {
	const d = store.descriptor(name);
	const dest = path.join(workspaceSystemDir(ws, 'collections'), `${name}.collection.yaml`);
	if (!fs.existsSync(dest)) throw new Error(`"${name}" is not workspace-owned — it ships with a module; add "<module>/${name}" to dreamteamer.disable instead`);
	const dataDir = path.join(ws.root, d.storage.path);
	const hasRecords = fs.existsSync(dataDir) && fs.readdirSync(dataDir).some((e) => !e.startsWith('.'));
	if (hasRecords && !force) throw new Error(`collection "${name}" still has records under ${d.storage.path} — remove them first or pass force`);
	writeGated(ws, store, [dest], `dreamteamer: collections rm ${name}`, () => fs.rmSync(dest));
	return { removed: name };
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
 * References are rewritten by asking the STORE to do it, once per record id, rather than by matching
 * the collection prefix with a new regex. `store.rewriteRefs` already knows the boundary rules and
 * already scopes prose to `[[wikilinks]]` (decision 7) — a fresh `oldName/` pattern would have to
 * relearn both, and would corrupt `data/tasks/` in a path or a URL on its first outing. N passes over
 * the record files is the price, and at human scale it is worth paying for reusing the correct code.
 *
 * ⚠ MEASURED 2026-08-17, so the cost is a number rather than a hope: a real 2,291-record collection
 * in a 3,391-file workspace takes **3 minutes**, of which 142s is system time — 7.7M file reads to
 * rewrite ZERO references, because the pass runs per id whether or not anything points at the
 * collection. Tolerable for a one-time migration and left alone on that basis; it is
 * O(records x files), so a workspace 3x larger pays 27 minutes.
 *
 * ⚠ REPRODUCED 2026-08-22 by `npm run perf -- --records=2291 --filler=1100`, which generates a
 * workspace that shape — 271s wall, 203s of it system, and **15.6M reads, not 7.7M**. The original
 * figure counted ONE pass per id; there are TWO, because `captureRefs` walks every record file for
 * the rollback snapshot before `rewriteRefs` walks them all again. `7.7M` is the per-pass number.
 * That is what a generated fixture is for: the finding was right about the shape and off by 2x on
 * the count, and no comment could have told you.
 *
 * The fix when it is needed is a batch entry point on the store that reads each file ONCE and loops
 * the ref set in memory, with `text.includes(oldName + '/')` as a cheap NEGATIVE filter only — never
 * as the matcher, for the reason above. Halving it is cheaper still: the snapshot pass and the
 * rewrite pass read the same bytes.
 */
export function renameCollection(ws, store, oldName, newName) {
	const d = store.descriptor(oldName); // throws with the known-collection list if absent
	if (!newName) throw new Error('missing new collection name');
	if (oldName === newName) return { renamed: false, name: newName };

	const declared = normalizeNamespaces(ws.pkg.dreamteamer?.namespaces);
	if (newName.includes('/') && !namespaceOf(newName, declared)) {
		throw new Error(`namespace "${newName.slice(0, newName.lastIndexOf('/'))}" is not declared — add it to dreamteamer.namespaces in package.json first.`);
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
		// referencing files are snapshotted by the store's own helper via rewriteRefs' touched list, so
		// they are captured here the same way `store.rename` does it: read before, restore on failure.
		const refFiles = new Map();
		const captureRefs = (ref) => {
			for (const f of store.findInboundRefs(ref)) {
				const abs = path.join(ws.root, f);
				if (!refFiles.has(abs)) refFiles.set(abs, fs.readFileSync(abs));
			}
		};
		for (const id of ids) captureRefs(`${oldName}/${id}`);
		captureRefs(`collections/${oldName}`);
		const restoreRefs = () => {
			for (const [f, bytes] of refFiles) {
				fs.mkdirSync(path.dirname(f), { recursive: true }); // pruneEmpty may have taken the parent
				fs.writeFileSync(f, bytes);
			}
		};

		const touched = new Set();
		let rewrites = 0;
		try {
			// 1. the descriptor source, at its new path — EDITED TEXTUALLY, never re-dumped.
			//
			// ⚠ `fs.writeFileSync(dest, dump(doc))` destroyed every comment in the descriptor, and a
			// descriptor's comments are where this project keeps its reasoning: 194 lines across 24
			// files in one real migration, including 22-line headers stating what belongs in a
			// collection and which failure mode it guards against. The record survived; the thinking
			// did not, and nothing said so.
			//
			// A rename changes exactly three scalars. Rewriting those three in place keeps the
			// comments, the key order and the author's formatting — and the parse afterwards proves
			// the edit landed rather than trusting the regex.
			const edited = setScalar(setScalar(setScalar(srcBytes.toString('utf8'),
				['name'], newName),
				['storage', 'path'], newPath),
				['storage', 'suffix'], newSuffix);
			const parsed = load(edited);
			if (parsed?.name !== newName || parsed?.storage?.path !== newPath || parsed?.storage?.suffix !== newSuffix) {
				throw new Error(`could not rewrite ${path.relative(ws.root, src)} in place — name/storage.path/storage.suffix did not take. nothing was changed.`);
			}
			doc.name = newName;
			doc.storage = { ...doc.storage, path: newPath, suffix: newSuffix };
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
			for (const id of ids) {
				const out = store.rewriteRefs(`${oldName}/${id}`, `${newName}/${id}`);
				rewrites += out.rewrites;
				for (const f of out.touched) touched.add(f);
			}
			const collOut = store.rewriteRefs(`collections/${oldName}`, `collections/${newName}`);
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
			// ⚠ TEXTUAL, for the same reason step 1 is. This used to `load` → mutate → `dump`, which
			// meant that ANY descriptor needing a retarget lost every comment in it — including the
			// renamed one itself when it self-references, which is how step 1's careful preservation
			// was undone one step later. 17 of the 24 descriptors stripped in the migration that
			// found this were stripped HERE, not there.
			//
			// `retargetRefs` still decides WHETHER a file is affected — it walks the parsed schema and
			// knows about nested properties and `items` — but the write is a line edit, and the parse
			// afterwards proves it landed.
			for (const f of descriptorSources(ws, store)) {
				const before = fs.readFileSync(f, 'utf8');
				const probe = load(before);
				if (!probe || !retargetRefs(probe.schema, oldName, newName)) continue;
				// ⚠ the boundary must cover THREE spellings: the block form (`x-reference: accounts` to
				// end of line), the inline flow form (`{ type: string, x-reference: accounts }`, where
				// the value ends at `,` or `}`), and a LIST — flow (`x-reference: [a, accounts, b]`) or
				// block (`x-reference:` + `- accounts` items). Anchoring on `$` alone silently matched
				// nothing in the flow form — and the assert below turned that silence into a refusal,
				// which is how it was found.
				const after = retargetRefText(before, oldName, newName);
				const reparsed = load(after);
				if (!reparsed || retargetRefs(reparsed.schema, oldName, newName)) {
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

		// `git add -- <path>` FAILS OUTRIGHT on a pathspec that is neither on disk nor in the index —
		// which is exactly what the old descriptor becomes when it was never committed in the first
		// place (a collection added but not yet published). One bad entry aborts the whole `add`, so
		// the rename rolled back over a file git simply did not care about. Filter, don't assume.
		const rels = [...touched]
			.map((f) => path.relative(ws.root, f))
			.filter((rel) => fs.existsSync(path.join(ws.root, rel)) || isTracked(ws.root, rel));
		try {
			execFileSync('git', ['add', '--all', '--', ...rels], { cwd: ws.root, stdio: GIT_QUIET });
			execFileSync('git', ['commit', '--quiet', '-m', `dreamteamer: collections rename ${oldName} → ${newName}`, '--', ...rels], { cwd: ws.root, stdio: GIT_QUIET });
		} catch (e) {
			try { execFileSync('git', ['reset', '--quiet', '--', ...rels], { cwd: ws.root, stdio: GIT_QUIET }); } catch { /* nothing staged */ }
			undo();
			restoreRefs();
			try { compile(ws); } catch { /* pre-rename sources were compilable */ }
			throw new Error(`git commit failed — the rename was rolled back, nothing was changed. (${e.message.split('\n')[0]})`);
		}

		return {
			renamed: true, name: newName, records: ids.length, rewrites,
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

/**
 * The TEXTUAL x-reference retarget — a line edit, never load→dump, so comments survive (see the
 * step-4 comment in renameCollection for the 17-descriptor lesson).
 *
 * Handles three spellings: scalar (`x-reference: old`), flow list (`x-reference: [a, old, b]`),
 * and block sequence (`x-reference:` + `- old` items tracked by indent under the key):
 *
 *   ```
 *   x-reference:
 *     - doctors
 *     - nurses
 *   ```
 *
 * Two YAML styles are deliberately NOT rewritten and fall through unchanged to the caller's
 * reparse-assert (which throws if the return does not compile), failing closed rather than
 * half-written:
 *
 *   - **Same-indent block sequence**: YAML allows `- items` at the PARENT's own indent
 *     (`x-reference:` and `- doctors` at the same indent level). The indent state machine
 *     requires strictly deeper dashes (`item[1].length > listIndent`), so this spelling is
 *     never entered and goes reparse-asserted instead.
 *   - **Multi-line flow list**: a flow list split across lines — `[` on one line, `]` on
 *     another. The flow regex requires both brackets and the body on the same line, so this
 *     spelling is not matched and goes reparse-asserted instead.
 *   - **A blank or comment line BETWEEN block-sequence items**: the item regex requires a
 *     leading `-`, so a blank line or a `#`-comment line inside the list resets `listIndent`
 *     early. Every item after the gap is then read as ordinary text rather than a list member,
 *     and (having no `x-reference:` key on its own line) is left untouched.
 *
 *   All three fail closed on purpose: the engine's own `dump()` always emits deeper-indented,
 *   gap-free sequences and single-line flow lists, so only a hand-authored descriptor can reach
 *   these styles. Anything trickier than the three handled spellings falls through unchanged —
 *   the caller reparses and REFUSES rather than guessing.
 */
function retargetRefText(text, oldName, newName) {
	const esc = oldName.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
	const quoted = newName.includes('/') ? `'${newName}'` : newName;
	const retag = (part) => {
		const m = part.match(/^(\s*)(['"]?)(.*?)\2(\s*)$/);
		return m && m[3] === oldName ? `${m[1]}${quoted}${m[4]}` : part;
	};
	const lines = text.split('\n');
	let listIndent = -1; // >= 0 while inside a block-sequence x-reference list
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (listIndent >= 0) {
			const item = line.match(/^(\s*)-\s*(['"]?)(.*?)\2\s*(#.*)?$/);
			if (item && item[1].length > listIndent) {
				if (item[3] === oldName) {
					lines[i] = line.replace(new RegExp(`(-\\s*)(['"]?)${esc}\\2`), (_m, lead) => `${lead}${quoted}`);
				}
				continue;
			}
			listIndent = -1;
		}
		const key = line.match(/^(\s*)x-reference:\s*(.*)$/);
		if (key && (key[2] === '' || key[2].startsWith('#'))) {
			listIndent = key[1].length;
			continue;
		}
		lines[i] = line
			.replace(new RegExp(`(x-reference:\\s*)(['"]?)${esc}\\2(?=\\s*(?:[,}]|#|$))`, 'gm'), (_m, lead) => `${lead}${quoted}`)
			.replace(/(x-reference:\s*\[)([^\]]*)(\])/g, (_m, open, body, close) => open + body.split(',').map(retag).join(',') + close);
	}
	return lines.join('\n');
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

export function addField(ws, store, collection, { name: fieldName, prop, required }) {
	store.descriptor(collection); // must exist in the compiled runtime
	if (!fieldName) throw new Error('missing field name');
	if (store.descriptor(collection).schema?.properties?.[fieldName]) throw new Error(`field "${fieldName}" already exists on ${collection}`);
	return upsertField(ws, store, collection, fieldName, prop, required, `add-field ${fieldName}`);
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

export function updateField(ws, store, collection, fieldName, { prop, required, flags = {}, stated }) {
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

	return upsertField(ws, store, collection, fieldName, prop, required, `update-field ${fieldName}`);
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
function refuseUnremovableField(ws, d, collection, fieldName, hasWorkspaceDoc) {
	const prop = d.schema.properties[fieldName];
	const holder = (prop.items && typeof prop.items === 'object') ? prop.items : prop;
	const of = holder['x-inverse-of'];
	if (typeof of === 'string') {
		// SPELLING B: the field is declared on THIS collection with `x-inverse-of`, compile folds that
		// declaration into the owner and regenerates the field under the same key — so a source still
		// carrying it IS the relation, and deleting it there is the removal. Name the file.
		const declaring = authoredField(ws, collection, fieldName).files;
		if (declaring.length) {
			throw new Error(`field "${fieldName}" on ${collection} DECLARES a relation (x-inverse-of: ${of}) in ${declaring.join(', ')} — that declaration is the relation, so deleting the field there removes it. This verb only edits the workspace module's own descriptor, which does not carry it.`);
		}
		// SPELLING A: nothing here declares it; compile stamped it from the owner's `x-inverse`, and
		// clearing that keyword is the removal. This remedy WORKS — the spelling-B one did not, because
		// the owner never carried an `x-inverse` to clear.
		const dot = of.lastIndexOf('.'); // a collection name may contain '/', so split at the LAST dot
		throw new Error(`field "${fieldName}" on ${collection} is GENERATED from ${of}, the two-way relation that owns it — no source of ${collection} declares it, so no edit here can remove it. Remove the relation instead: dreamteamer schema update-field ${of.slice(0, dot)} --name ${of.slice(dot + 1)} --inverse=`);
	}
	throw new Error(hasWorkspaceDoc
		? `field "${fieldName}" is inherited from the base module — the workspace descriptor doesn't declare it`
		: `"${collection}" is module-shipped; the workspace can only OVERRIDE fields (extends), not remove them`);
}

export function removeField(ws, store, collection, fieldName) {
	const d = store.descriptor(collection);
	if (!d.schema?.properties?.[fieldName]) throw new Error(`no field "${fieldName}" on ${collection}`);
	// Removing the OWNING foreign key drops the relation just as `--inverse=` does, and leaves the
	// same residue on the target. Same sweep, same commit.
	const was = relationsOwnedBy(store, collection, fieldName);
	const dest = path.join(workspaceSystemDir(ws, 'collections'), `${collection}.collection.yaml`);
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
		fs.writeFileSync(dest, writeDescriptor(previousText, doc));
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
	});
	return { collection, removed: fieldName, dropped: out.dropped, cleared: out.cleared };
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

function upsertField(ws, store, collection, fieldName, prop, required, verb) {
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
	const dest = path.join(workspaceSystemDir(ws, 'collections'), `${collection}.collection.yaml`);
	let doc;
	// The BYTES, not just the parse: `dump` cannot round-trip a comment, and a collection descriptor is
	// where a module writes down why the collection exists (see reattachComments).
	let previousText = null;
	if (fs.existsSync(dest)) {
		previousText = fs.readFileSync(dest, 'utf8');
		doc = load(previousText);
	} else {
		doc = { name: collection, extends: baseModuleRef(ws.root, collection), schema: { properties: {} } };
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
	const dropped = writeGated(ws, store, [dest], `dreamteamer: ${collection} ${verb}`, () => {
		doc.schema ??= { properties: {} };
		doc.schema.properties ??= {};
		doc.schema.properties = insertBeforeBody(doc.schema.properties, fieldName, prop);
		if (required === true) doc.schema.required = [...new Set([...(doc.schema.required ?? []), fieldName])];
		if (required === false && Array.isArray(doc.schema.required)) doc.schema.required = doc.schema.required.filter((r) => r !== fieldName);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, writeDescriptor(previousText, doc));
	}, () => dropOrphanedMirrors(new Store(ws), was)).dropped;
	// the prop as WRITTEN — callers report the relation off this, never off the one they passed:
	// both this function and updateField reassign it, so a caller's own copy can be a stale object.
	return { collection, field: fieldName, file: dest, extends: doc.extends, prop, dropped };
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

/**
 * Re-attach a rewritten YAML source's COMMENTS — the part `dump` cannot round-trip.
 *
 * js-yaml drops every comment on `load` → `dump`. That is fine for a generated artifact and wrong
 * for a module SOURCE, which is where this project writes down why something exists (`setScalar`
 * above exists for the same reason). A real round-trip needs a different YAML library and core is
 * not taking one on for this, so this does the narrow thing that is actually safe: a comment block
 * sitting directly above a TOP-LEVEL key is carried back above that same key, if the key survived.
 * The file header comes along for free — it is the block above the first key.
 *
 * ⚠ Deliberately top-level only. A comment above a NESTED key cannot be re-placed without knowing
 * where that key ended up, and a misplaced comment is worse than an absent one: it would attach an
 * explanation to something it does not explain. Those are still lost. Measured against
 * `modules/family/ui-views/health-labs-abnormal.ui-view.yaml`, whose two blocks — the file header
 * and the ⚠ above `filter:` — are both top-level and both survive.
 */
function reattachComments(oldText, newText) {
	const TOP_KEY = /^([A-Za-z_][\w-]*):/;
	const blocks = new Map(); // surviving key -> the comment lines that sat above it
	let pending = [];
	for (const line of oldText.split('\n')) {
		if (line.startsWith('#') || line.trim() === '') { pending.push(line); continue; }
		const key = TOP_KEY.exec(line)?.[1];
		if (key && pending.some((l) => l.startsWith('#'))) {
			while (pending.length && pending[pending.length - 1].trim() === '') pending.pop();
			blocks.set(key, pending);
		}
		pending = [];
	}
	if (!blocks.size) return newText;

	const out = [];
	for (const line of newText.split('\n')) {
		const block = blocks.get(TOP_KEY.exec(line)?.[1]);
		if (block) out.push(...block);
		out.push(line);
	}
	return out.join('\n');
}

/**
 * Serialize a collection descriptor back to its source, keeping what `dump` cannot.
 *
 * ⚠ THIS IS A PARTIAL FIX, AND THE LIMITS ARE THE REASON IT IS WORTH HAVING ANYWAY. A descriptor is
 * hand-written, and it is where a module records WHY a collection exists — so `add-field` rewriting
 * it through `load` → mutate → `dump` deleted every comment in the file. Measured on a four-comment
 * descriptor: one `dt schema add-field` took it to zero. The consequence was not cosmetic: the
 * schema verbs were unusable on any commented descriptor, so real relations got authored by hand in
 * a text editor instead, which is the CLI losing to an editor for a job it owns.
 *
 * `reattachComments` recovers a comment block sitting above a TOP-LEVEL key, the file header
 * included — 25 of the 27 comment lines across this engine's own descriptors. What is still lost,
 * stated here rather than discovered later:
 *
 *   - A comment above a NESTED key (inside `schema.properties.<field>`, the natural place to explain
 *     one field). Re-placing it needs to know where that key ended up, and a misplaced comment is
 *     worse than an absent one — it attaches an explanation to something it does not explain.
 *   - STYLE. `dump` emits its own defaults, so an inline `storage: { suffix: thing }` comes back as a
 *     block mapping and a hand-folded scalar comes back on one line. The diff is the whole file
 *     however small the edit.
 *   - The RECORD half of the same bug, which is a different call site entirely (`store.serialize`)
 *     and untouched: `dt set` on one field rewraps every folded scalar and expands every flow
 *     sequence in the frontmatter.
 *
 * All three need a YAML library that keeps a document's syntax tree; js-yaml has no such API, and
 * the change fans out through every reader and writer in the record layer. `setScalar` above states
 * the same conclusion from the other end.
 */
function writeDescriptor(previousText, doc) {
	return previousText === null ? dump(doc) : reattachComments(previousText, dump(doc));
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
	writeGated(ws, store, [dest], `dreamteamer: ui-views ${existed ? 'update' : 'add'} ${id}`, () => {
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, previous === null ? dump(view) : reattachComments(previous, dump(view)));
	});
	return { id, file: dest, updated: existed };
}

export function removeUiView(ws, store, id) {
	// Same source resolution as the save above — an inline module's view is under this repo's git
	// history like everything else, so deleting it is one revertable commit. Refusing it while
	// ALLOWING a save to the same file would be an asymmetry with nothing behind it.
	const { file: dest, shipped } = uiViewSourceFile(ws, id);
	if (shipped && /(^|\/)node_modules\//.test(shipped))
		throw new Error(`ui-view "${id}" is shipped by an installed package (${shipped}) — removing the file would be undone by the next npm install.\n  disable it instead: add "<module>/${id}" to dreamteamer.disable in package.json.`);
	if (!fs.existsSync(dest)) throw new Error(`ui-view "${id}" does not exist`);
	writeGated(ws, store, [dest], `dreamteamer: ui-views rm ${id}`, () => fs.rmSync(dest));
	return { removed: id };
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

function singular(name) {
	return name.endsWith('ies') ? name.slice(0, -3) + 'y' : name.endsWith('s') ? name.slice(0, -1) : name;
}
