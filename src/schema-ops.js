// schema operations — source-writing mutations shared by the CLI meta verbs and the
// server's schema endpoints. the contract (audit finding 11, clean-room bug 2): an op
// writes sources, proves them with a REAL compile, and only then commits — an
// uncompilable source can never land in history. the successful gate compile also
// leaves the runtime fresh, which kills the add-field-right-after-collections-add
// papercut (review finding 7): schema ops ARE explicit compiles.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { load, dump, parseDoc, stringifyDoc } from './yaml.js';
import { compile, kindDir, titleCase } from './compile.js';
import { readManifest, runtimeKindDir } from './runtime.js';
import { normalizeNamespaces, namespaceOf, baseNameOf, qualify, defaultStoragePath } from './namespace.js';

// Same rule as store.js: a git failure we CATCH must not also print git's own error on top of the
// clean message we throw. stdout stays piped because some callers read it.
const GIT_QUIET = ['ignore', 'pipe', 'ignore'];
import { walk, EXT } from './records.js';

// ---- the gate -------------------------------------------------------------------

function writeGated(ws, store, files, subject, mutate) {
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
		const rels = files.map((f) => path.relative(ws.root, f));
		// Schema ops commit UNCONDITIONALLY — `auto-commit` governs RECORD writes only. A source
		// change is inseparable from the compile that validated it, and `dt commit` scopes itself
		// to record directories, so a deferred source edit would be publishable by nothing.
		// Extending `dt commit` to module sources is the natural follow-on; it is not this wave.
		try {
			execFileSync('git', ['add', '--', ...rels], { cwd: ws.root, stdio: GIT_QUIET });
			execFileSync('git', ['commit', '--quiet', '-m', subject, '--', ...rels], { cwd: ws.root, stdio: GIT_QUIET });
		} catch (e) {
			try { execFileSync('git', ['reset', '--quiet', '--', ...rels], { cwd: ws.root, stdio: GIT_QUIET }); } catch { /* nothing staged */ }
			restore();
			try { compile(ws); } catch { /* pre-op sources were compilable */ }
			throw new Error(`git commit failed — the schema change was rolled back, nothing was changed. (${e.message.split('\n')[0]})`);
		}
	});
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
 * three scalars a rename changes.
 *
 * ⚠ The round-trip YAML library this header used to defer to IS in the tree now (yaml.js exports
 * parseDoc, and upsertField/removeField edit through it). setScalar survives anyway, deliberately:
 * a Document re-render normalizes formatting the author chose — flow padding, fold points of long
 * scalars — while this touches ONLY the edited line. Measured on this repo's own descriptors:
 * 0/11 survive parseDoc→toString byte-identical. For a rename, whose diff a reviewer reads as
 * "three scalars changed", byte-precision on every untouched line is worth two regexes.
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
				const ext = EXT[d.storage.codec ?? 'md'];
				for (const file of walk(newDir)) {
					if (!file.endsWith(`.${oldSuffix}${ext}`)) continue;
					const to = file.slice(0, -(oldSuffix.length + ext.length + 1)) + `.${newSuffix}${ext}`;
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
				// ⚠ the boundary must cover BOTH spellings. A descriptor may write the block form
				// (`x-reference: accounts` to end of line) or the inline flow form
				// (`{ type: string, x-reference: accounts }`), where the value ends at `,` or `}`.
				// Anchoring on `$` alone silently matched nothing in the flow form — and the assert
				// below turned that silence into a refusal, which is how it was found.
				const after = before.replace(
					new RegExp(`(x-reference:\\s*)(['"]?)${oldName.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\2(?=\\s*(?:[,}]|#|$))`, 'gm'),
					(_m, lead) => `${lead}${newName.includes('/') ? `'${newName}'` : newName}`);
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

/** Rewrite `x-reference: old` → new anywhere in a schema. Returns true if anything changed. */
function retargetRefs(schema, oldName, newName) {
	let changed = false;
	for (const prop of Object.values(schema?.properties ?? {})) {
		if (!prop || typeof prop !== 'object') continue;
		for (const holder of [prop, prop.items]) {
			if (holder && typeof holder === 'object' && holder['x-reference'] === oldName) {
				holder['x-reference'] = newName;
				changed = true;
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

export function addField(ws, store, collection, { name: fieldName, prop, required }) {
	store.descriptor(collection); // must exist in the compiled runtime
	if (!fieldName) throw new Error('missing field name');
	if (store.descriptor(collection).schema?.properties?.[fieldName]) throw new Error(`field "${fieldName}" already exists on ${collection}`);
	return upsertField(ws, store, collection, fieldName, prop, required, `add-field ${fieldName}`);
}

export function updateField(ws, store, collection, fieldName, { prop, required }) {
	const d = store.descriptor(collection);
	if (!d.schema?.properties?.[fieldName]) throw new Error(`no field "${fieldName}" on ${collection}`);
	// upsertField REPLACES the prop, so retyping a field would silently drop its hand-authored
	// `description`. Changing a field's type is not a decision to undocument it. Same for an
	// authored `title` — but ONLY an authored one: a derived title is compile's output, not a
	// human's choice, and `titleCase` is how the two are told apart.
	const previous = d.schema.properties[fieldName];
	if (prop.description === undefined && typeof previous.description === 'string') prop = { ...prop, description: previous.description };
	if (prop.title === undefined && typeof previous.title === 'string' && previous.title !== titleCase(fieldName)) prop = { ...prop, title: previous.title };
	return upsertField(ws, store, collection, fieldName, prop, required, `update-field ${fieldName}`);
}

export function removeField(ws, store, collection, fieldName) {
	const d = store.descriptor(collection);
	if (!d.schema?.properties?.[fieldName]) throw new Error(`no field "${fieldName}" on ${collection}`);
	const dest = path.join(workspaceSystemDir(ws, 'collections'), `${collection}.collection.yaml`);
	if (!fs.existsSync(dest)) throw new Error(`"${collection}" is module-shipped; the workspace can only OVERRIDE fields (extends), not remove them`);
	const text = fs.readFileSync(dest, 'utf8');
	const probe = load(text);
	if (!probe.schema?.properties?.[fieldName]) throw new Error(`field "${fieldName}" is inherited from the base module — the workspace descriptor doesn't declare it`);
	writeGated(ws, store, [dest], `dreamteamer: ${collection} remove-field ${fieldName}`, () => {
		// edited as a DOCUMENT, not load→dump: a descriptor source is where this project writes down
		// why a field exists, and re-dumping the file destroyed every comment in it (same loss the
		// rename scar records — this site just went unnoticed longer).
		const doc = parseDoc(text);
		doc.deleteIn(['schema', 'properties', fieldName]);
		dropRequired(doc, fieldName);
		fs.writeFileSync(dest, stringifyDoc(doc));
	});
	return { collection, removed: fieldName };
}

function upsertField(ws, store, collection, fieldName, prop, required, verb) {
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
	// is a real authored override.
	const ref = prop['x-reference'] ?? prop.items?.['x-reference'];
	const inherited = ref && ref !== '*' ? store.descriptors.get(ref)?.title_template : undefined;
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
	const text = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
	const extendsRef = text ? load(text)?.extends : baseModuleRef(ws.root, collection);
	writeGated(ws, store, [dest], `dreamteamer: ${collection} ${verb}`, () => {
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		if (text === null) {
			// a fresh overlay has no comments to preserve — a plain dump is the simple, correct write
			const fresh = { name: collection, extends: extendsRef, schema: { properties: { [fieldName]: prop } } };
			if (required === true) fresh.schema.required = [fieldName];
			fs.writeFileSync(dest, dump(fresh));
			return;
		}
		// edited as a DOCUMENT (see removeField): only the field being (re)defined is replaced, so a
		// comment above a NEIGHBOURING field survives an add-field it had nothing to do with. The
		// edited field's own comment goes with the definition it described — that is the edit.
		const doc = parseDoc(text);
		doc.setIn(['schema', 'properties', fieldName], prop);
		if (required === true) {
			const req = doc.getIn(['schema', 'required'], true);
			if (!req?.items) doc.setIn(['schema', 'required'], [fieldName]);
			else if (!req.items.some((n) => n.value === fieldName)) req.add(fieldName); // in place — the seq keeps its authored flow/block style
		}
		if (required === false) dropRequired(doc, fieldName);
		fs.writeFileSync(dest, stringifyDoc(doc));
	});
	return { collection, field: fieldName, file: dest, extends: extendsRef };
}

/** Remove `fieldName` from a document's schema.required IN PLACE — filtering the seq's items keeps
 *  its authored style (flow `[a, b]` stays flow), where a setIn with a fresh array would not. */
function dropRequired(doc, fieldName) {
	const req = doc.getIn(['schema', 'required'], true);
	if (req?.items) req.items = req.items.filter((n) => n.value !== fieldName);
}

// saved views (M3): a studio-saved view IS a ui-view record — but ui-views are
// system-stored (sources + compile), so the write goes through the same gate as any
// other schema op. the studio "save view" button lands here.
export function saveUiView(ws, store, { id, view }) {
	if (!id || !/^[a-z0-9][a-z0-9-/]*$/.test(id)) throw new Error(`invalid ui-view id "${id}" — lowercase slug required`);
	const dest = path.join(workspaceSystemDir(ws, 'ui-views'), `${id}.ui-view.yaml`);
	const existed = fs.existsSync(dest);
	writeGated(ws, store, [dest], `dreamteamer: ui-views ${existed ? 'update' : 'add'} ${id}`, () => {
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, dump(view));
	});
	return { id, file: dest, updated: existed };
}

export function removeUiView(ws, store, id) {
	const dest = path.join(workspaceSystemDir(ws, 'ui-views'), `${id}.ui-view.yaml`);
	if (!fs.existsSync(dest)) throw new Error(`ui-view "${id}" is not workspace-owned (module-shipped views are removed via dreamteamer.disable)`);
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

// CLI/API type sugar → JSON Schema property
export function fieldDef(store, flags) {
	const t = flags.type ?? 'string';
	const def = flags['default-value'] ?? flags.default;
	const p = (() => {
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
				const opts = Array.isArray(flags.options) ? flags.options : flags.options.split(',').map((s) => s.trim());
				return { type: 'string', enum: opts };
			}
			case 'tags': return { type: 'array', items: { type: 'string' } };
			default:
				if (store.descriptors.has(t)) return { type: 'string', 'x-reference': t };
				if (t === 'reference') return { type: 'string', 'x-reference': flags.target ?? '*' };
				throw new Error(`unknown field type "${t}"`);
		}
	})();
	if (def !== undefined) p.default = p.type === 'boolean' ? def === 'true' || def === true : p.type === 'number' || p.type === 'integer' ? Number(def) : def;
	// what the field MEANS, in one line — JSON Schema's own keyword, projected to every surface by
	// presentation.js. A field whose name doesn't say enough is documented here, not in a comment.
	if (typeof flags.description === 'string' && flags.description.length > 0) p.description = flags.description;
	return p;
}

function singular(name) {
	return name.endsWith('ies') ? name.slice(0, -3) + 'y' : name.endsWith('s') ? name.slice(0, -1) : name;
}
