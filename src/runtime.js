// THE BOUNDARY — `.dreamteamer/` is the one artifact the two halves of this engine share.
//
// The workspace compiler WRITES it (compile.js: modules × sources → merged descriptors + manifest).
// The record layer READS it, and reads nothing else: store.js has never needed to know that
// modules, channels, `extends` or `templates` exist. That seam was already real — it just wasn't
// enforceable, because reaching the compiled output meant importing compile.js, which put a
// record-layer → compiler edge in the graph for what is really a file-format dependency.
//
// Everything the record layer actually wanted is already IN the compiled output: the merged
// descriptors, and (in the manifest) which directories hold the sources behind runtime-based
// records. So this module owns the runtime's shape, both halves import it, and `npm run layers`
// fails if the old edge comes back.
import fs from 'node:fs';
import path from 'node:path';
import { load } from './yaml.js';
import { normalizeNamespaces } from './namespace.js';

export const RUNTIME_DIR = '.dreamteamer';

/**
 * Runtime kinds compile PROJECTS rather than stages — they have no source folder under a module
 * root, so nothing can be "edited and recompiled" in the usual place. Lives here, in the boundary,
 * because it is a fact about the runtime's SHAPE: the compiler writes them and the record layer has
 * to describe them, and neither half should learn it from the other (the `storage.base` precedent).
 */
export const DERIVED_KINDS = ['modules'];

/**
 * Where a human edits a compiled collection, as one sentence. ONE definition, because there are two
 * consumers who must never drift: the store's refusal (`dt set modules/<id> …`) and the presentation
 * projection the UI reads to explain a disabled button. This repo's own history is the argument —
 * `git log`/`git diff` and the `?sort=` comparator were each hand-copied into the extension and
 * went wrong in both places.
 */
export function sourceHint(d) {
	return DERIVED_KINDS.includes(d?.storage?.path)
		? "the source it was projected from (for `modules`, the module's package.json)"
		: `the file under the owning module (modules/<module>/${d?.storage?.path}/)`;
}

/** One message, two callers with different manners: the store throws it, `check` prints it. */
export const NO_RUNTIME = 'no compiled runtime — run `dreamteamer compile` first';

export function runtimeDir(root) {
	return path.join(root, RUNTIME_DIR);
}

export function readManifest(root) {
	try { return load(fs.readFileSync(path.join(runtimeDir(root), 'manifest.yaml'), 'utf8')); } catch { return null; }
}

/**
 * A kind's folder inside the compiled runtime. Flat (`.dreamteamer/<kind>`) is what compile writes;
 * `.dreamteamer/system/<kind>` is probed because the runtime on disk may have been compiled by an
 * engine from before the flatten — a stale runtime is the normal state between a `git pull` and the
 * next `dt compile`, and answering "no compiled runtime" for one would be a lie.
 */
export function runtimeKindDir(root, kind) {
	const flat = path.join(runtimeDir(root), kind);
	if (fs.existsSync(flat)) return flat;
	const nested = path.join(runtimeDir(root), 'system', kind);
	return fs.existsSync(nested) ? nested : flat;
}

/**
 * The merged collection descriptors, keyed by name — or `null` when nothing has been compiled.
 *
 * The ONE place descriptors are read, so the one place `storage.base` is guaranteed present. Both
 * readers (store.js, check.js) had their own copy of this loop; the store's copy threw and check's
 * printed-and-returned-2, so the difference is kept at the call site rather than in the loader.
 */
export function loadDescriptors(root) {
	const dir = runtimeKindDir(root, 'collections');
	if (!fs.existsSync(dir)) return null;
	const out = new Map();
	// RECURSIVE, because a namespaced collection compiles to `collections/<ns>/<name>.collection.yaml`
	// and this loop used to read exactly one directory level. ⚠ That was a SILENT failure, not an
	// error: compile wrote the nested file and reported ✔, this returned a Map without it, and the
	// collection was simply absent — `dt <c> list` said "unknown collection" for something that had
	// just compiled successfully. Keep the walk.
	for (const f of walkDescriptors(dir)) {
		const d = load(fs.readFileSync(f, 'utf8'));
		d.storage ??= {};
		d.storage.base ??= derivedBase(d);
		out.set(d.name, d);
	}
	return out;
}

/** Every `*.collection.yaml` under a directory, at any depth, in a stable order. */
function walkDescriptors(dir, out = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (e.name.startsWith('.')) continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walkDescriptors(p, out);
		else if (e.name.endsWith('.collection.yaml')) out.push(p);
	}
	return out;
}

/**
 * The workspace's declared namespaces, longest-first — the closed set every reference is split
 * against. Read off the MANIFEST rather than package.json so the record layer keeps its single
 * dependency on the compiled artifact (the `sourceRoots()` precedent), and so a runtime compiled
 * before namespaces existed answers `[]` instead of throwing.
 */
export function namespaces(root) {
	return normalizeNamespaces(readManifest(root)?.namespaces);
}

/**
 * Which root `storage.path` is relative to — the whole of what the record layer needs to know about
 * the system/data distinction, as DATA rather than as a string test it has to perform. `runtime` =
 * compiled sources (skills, agents, ui-views, the descriptors themselves): generated, gitignored,
 * and therefore not writable through the store. `workspace` = data/ and state/ records.
 *
 * compile.js writes the field. This derivation is compat for a runtime compiled by an OLDER engine,
 * and is not optional: without it those collections resolve under the workspace root, where — in the
 * `workspace-module` layout — they do not exist. That reads as zero records (a silent success) and
 * lets `writableDescriptor` treat a compiled artifact as writable. Wrong in the expensive direction.
 *
 * ⚠ It tests for `system/`, which the flatten removed — that is correct and not a leftover. The only
 * descriptors reaching it are ones compiled BEFORE `base` existed, and those necessarily still spell
 * their runtime paths `system/<kind>`. Every descriptor this engine writes carries `base` explicitly.
 */
function derivedBase(d) {
	return String(d.storage?.path ?? '').startsWith('system/') ? 'runtime' : 'workspace';
}

/**
 * Absolute directories that may hold the SOURCES behind runtime-based records — every compiled
 * module except npm copies (foreign installed artifacts, never rewrite targets), plus the workspace
 * root. Used by ref surgery: renaming `collections/x` has to reach the descriptor in whichever
 * module ships it, not the merged copy under `.dreamteamer/`.
 *
 * Read from the manifest rather than by re-running module discovery, which is both cheaper and more
 * honest: the manifest records what was actually compiled, so a shadowed copy is already excluded.
 */
export function sourceRoots(root) {
	const modules = readManifest(root)?.modules ?? [];
	const roots = [root, ...modules.filter((m) => m.channel !== 'npm').map((m) => path.resolve(root, m.root))];
	return [...new Set(roots)];
}
