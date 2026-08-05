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

export const RUNTIME_DIR = '.dreamteamer';

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
	for (const f of fs.readdirSync(dir).sort()) {
		if (!f.endsWith('.collection.yaml')) continue;
		const d = load(fs.readFileSync(path.join(dir, f), 'utf8'));
		d.storage ??= {};
		d.storage.base ??= derivedBase(d);
		out.set(d.name, d);
	}
	return out;
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
