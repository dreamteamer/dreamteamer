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
import { storageOf } from './descriptor.js';
import { normalizeNamespaces } from './namespace.js';

export const RUNTIME_DIR = '.dreamteamer';

/**
 * `name@version` of the RUNNING engine — the dev clone or the installed copy, whichever loaded.
 *
 * ⚠ IT LIVES HERE, NOT IN `compile.js`, BECAUSE A LEDGER STAMPS IT. A proof runner writes the engine
 * version onto every ledger row (a per-machine record of what judged what), and reaching back into
 * the compiler for one string closed a runner ↔ `compile` import cycle — function-level and
 * therefore working, right up until someone calls a prove export at compile.js's module scope. The
 * engine's own identity is a fact about the boundary, the same way `RUNTIME_DIR` is: `compile.js`
 * re-exports both names so its existing callers are unchanged.
 *
 * `../package.json` resolves against THIS file's URL, which is `src/`, so it is the engine root's
 * manifest either way — and a failure to read it is `dreamteamer@unknown` rather than a throw,
 * because a version string is never worth crashing a compile or a proof over.
 */
export function engineId() {
	try {
		const p = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
		return `${p.name}@${p.version}`;
	} catch { return 'dreamteamer@unknown'; }
}

/** Bare semver of the running engine — what the manifest's `engine` key and every ledger row carry. */
export function engineVersion() {
	return engineId().split('@').pop();
}

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
	const p = storageOf(d).path;
	return DERIVED_KINDS.includes(p)
		? "the source it was projected from (for `modules`, the module's package.json)"
		: `the file under the owning module (modules/<module>/${p}/)`;
}

/** One message, two callers with different manners: the store throws it, `check` prints it. */
export const NO_RUNTIME = 'no compiled runtime — run `dreamteamer compile` first';

export function runtimeDir(root) {
	return path.join(root, RUNTIME_DIR);
}

export function readManifest(root) {
	try { return load(fs.readFileSync(path.join(runtimeDir(root), 'manifest.yaml'), 'utf8')); } catch { return null; }
}

/** A kind's folder inside the compiled runtime. */
export function runtimeKindDir(root, kind) {
	return path.join(runtimeDir(root), kind);
}

/** One message for a runtime compiled from v1 descriptors by an older engine. */
export const STALE_RUNTIME = 'the compiled runtime predates descriptor format v2 — run `dreamteamer compile`';

/**
 * The merged collection descriptors, keyed by name — or `null` when nothing has been compiled.
 *
 * The ONE place descriptors are read. A descriptor without its `compiled` block was written by an
 * engine that read v1 sources; it is refused with the one message that fixes it, rather than read.
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
		if (!d?.compiled) throw new Error(STALE_RUNTIME);
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
	// ⚠ EITHER SPELLING. `location` is what this engine writes; `channel` is what every runtime on
	// disk before 0.19.0 has, and a stale runtime is the NORMAL state between a `git pull` and the
	// next `dt compile`. Reading only the new key would silently make this list the workspace root
	// alone — and this list is what ref surgery walks, so "silently fewer modules" means a rename
	// that reports ✔ and leaves half the references dangling.
	const isNpm = (m) => (m.location ? m.location === 'node_modules' : m.channel === 'npm');
	const roots = [root, ...modules.filter((m) => !isNpm(m)).map((m) => path.resolve(root, m.root))];
	return [...new Set(roots)];
}
