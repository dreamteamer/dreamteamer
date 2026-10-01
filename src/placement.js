// RELATIONSHIP-BASED STORAGE — a record stored UNDER the record it belongs to.
//
// A child collection declares, on its own `storage` block, which scalar reference field names its
// parent and where inside the parent's folder its records go:
//
//     storage: { path: data/meetings, under: { field: company, path: meetings } }
//
// so a meeting whose `company` is `companies/northwind` lives at
// `data/companies/northwind/meetings/<id>.meeting.md`, and one with no company stays in the
// collection's own root (`data/meetings/`). The parent must be a folder-shape collection, because
// only a folder can hold anything beside the record itself. compile derives `under.collection`
// from the field's `x-reference`, so the record layer never reads a schema to find the parent.
//
// Three invariants every reader and writer here holds:
//   - ONE logical collection. Listing walks the fallback root and every parent's child folder;
//     a reference is `<collection>/<id>` wherever the file sits. The id is the path inside
//     WHICHEVER root the file is in, so moving a record between parents changes no id.
//   - PLACEMENT FOLLOWS THE FIELD, never the other way round. The field is the intended owner and
//     the folder is observed placement; `check` reports the two disagreeing and `relocate` reconciles
//     them. Nothing ever infers an owner from where a file was found.
//   - ONE LEVEL. A placed collection cannot itself be a parent — enough for company → meetings /
//     contacts / projects, and the nesting a second level needs can be added when something wants it.
//
// This module is in the RECORD layer and reads compiled descriptors only: nothing here knows what a
// module, an overlay or a schema source is. Store and check both enumerate through it so they cannot
// disagree about which files are records.
import fs from 'node:fs';
import path from 'node:path';
import { walk, idFromRecordPath } from './records.js';

/** The compiled `storage.under` of a descriptor, or null for conventional storage. */
export function placementOf(d) {
	return d?.storage?.under ?? null;
}

/**
 * Why `p` is not an acceptable `under.path`, as a sentence — or null. A relative subfolder of the
 * parent record's folder: no absolute path, no traversal, no empty segment, no backslash (the same
 * alphabet `assertSafeId` holds ids to, because this path is joined onto the filesystem too).
 */
export function subpathProblem(p) {
	if (typeof p !== 'string' || p === '') return 'must be a relative folder path inside the parent record\'s folder (e.g. `meetings`)';
	if (p.startsWith('/') || p.includes('\\')) return `"${p}" must be relative to the parent record's folder — no leading slash, no backslashes`;
	if (p.split('/').some((s) => s === '' || s === '.' || s === '..')) return `"${p}" may not contain "." or ".." segments or an empty one`;
	return null;
}

/** `[id, folder]` for every record folder in a folder-shape collection's directory, sorted by id.
 *  A folder without its entry file is still listed: records placed under it must stay discoverable
 *  (`check` reports the missing entry on the parent and the dangling owner on each child). */
export function parentFolders(parentDir) {
	if (!fs.existsSync(parentDir)) return [];
	const out = [];
	for (const e of fs.readdirSync(parentDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (e.name.startsWith('.') || !e.isDirectory()) continue;
		out.push([e.name, path.join(parentDir, e.name)]);
	}
	return out;
}

/** The folder a placed record of `d` lives in when its owner is `parentId` — or the fallback root. */
export function placedRoot(under, fallbackDir, parentDir, parentId) {
	return parentId ? path.join(parentDir, parentId, under.path) : fallbackDir;
}

/** Every record file of `d` under ONE root, as `{ id, file, root, parentId }`. */
export function* rootRecords(d, root, parentId = null) {
	if (!fs.existsSync(root)) return;
	for (const f of walk(root)) {
		const id = idFromRecordPath(d, path.relative(root, f));
		if (id !== null) yield { id, file: f, root, parentId };
	}
}

/**
 * Every record file of a placed collection across all its roots: the fallback root first, then each
 * parent folder's child root in parent-id order. Duplicates are NOT resolved here — a caller that
 * keeps a map keeps the first and reports the rest; last-one-wins is the one answer this must never give.
 */
export function* placedRecords(d, fallbackDir, parentDir) {
	const under = placementOf(d);
	yield* rootRecords(d, fallbackDir, null);
	for (const [pid, folder] of parentFolders(parentDir)) {
		const root = path.join(folder, under.path);
		// a child root reached through a symlink is not read: whatever it points at is not this
		// parent's folder (see symlinkBelow) — `check` names it, the store simply does not see it
		if (symlinkBelow(parentDir, root)) continue;
		yield* rootRecords(d, root, pid);
	}
}

/** The child roots under `parentDir` that are symlinks (or sit behind one), for `check` to report. */
export function symlinkedChildRoots(under, parentDir) {
	const out = [];
	for (const [, folder] of parentFolders(parentDir)) {
		const link = symlinkBelow(parentDir, path.join(folder, under.path));
		if (link) out.push(link);
	}
	return out;
}

/**
 * The parent id a record's owner field names, or null when the field is empty. `parseRef` is passed
 * in (bound to the workspace's namespaces) so this stays pure. A value that parses to some OTHER
 * collection is not an owner either — the reference check reports it; placement does not guess.
 */
export function ownerIdOf(fields, under, parseRef) {
	const v = fields?.[under.field];
	if (typeof v !== 'string' || v === '') return null;
	const p = parseRef(v);
	return p && p.collection === under.collection ? p.id : null;
}

/**
 * Where a FILE of a placed collection sits: `{ root, parentId }` — the fallback root, or the child
 * root inside one parent's folder — or null when the path is under neither. The inverse of
 * `placedRoot`, used to prune the right directories after a move and to compare observed placement
 * with the owner the record declares.
 */
export function placementOfFile(under, file, fallbackDir, parentDir) {
	const inside = (dir) => {
		const r = path.relative(dir, file);
		return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : null;
	};
	if (inside(fallbackDir)) return { root: fallbackDir, parentId: null };
	const rel = inside(parentDir);
	if (!rel) return null;
	const parentId = rel.split(path.sep)[0];
	return { root: path.join(parentDir, parentId, under.path), parentId };
}

/**
 * Map a path INSIDE a folder-shape parent's directory to the placed child record it holds, if any.
 * `rest` is the path relative to the parent collection's `storage.path` (`<parentId>/<under.path>/…`).
 * Shared by `events.pathToRecord` (git paths → records) and nothing else re-derives it.
 */
export function placedChildAt(descriptors, parentName, rest) {
	const slash = rest.indexOf('/');
	if (slash < 1) return null;
	const sub = rest.slice(slash + 1);
	for (const c of descriptors.values()) {
		const under = placementOf(c);
		if (under?.collection !== parentName) continue;
		const pre = `${under.path}/`;
		if (!sub.startsWith(pre)) continue;
		const id = idFromRecordPath(c, sub.slice(pre.length));
		if (id !== null) return { collection: c.name, id };
	}
	return null;
}

/**
 * The first SYMLINK on the way from `base` (exclusive) down to `target` (inclusive), or null.
 *
 * ⚠ Lexical validation of `under.path` does not establish containment: a symlink dropped at
 * `data/companies/acme/meetings` points every "placed" write at wherever it likes, and a walk reads
 * whatever sits there as records. So a placed record is written and read only through REAL
 * directories below the parent collection's root — every existing component is `lstat`ed, and the
 * first link ends the enquiry. Components that do not exist yet are fine: they are about to be
 * created as real directories. The collection's own roots (`storage.path`, `data/` itself) are not
 * subject to this — a workspace may legitimately keep its data folder behind a link; the rule is
 * about what a RECORD FOLDER may contain.
 */
export function symlinkBelow(base, target) {
	const rel = path.relative(base, target);
	if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
	let p = base;
	for (const seg of rel.split(path.sep)) {
		p = path.join(p, seg);
		let st;
		try { st = fs.lstatSync(p); } catch { return null; } // not there yet — nothing below can be a link either
		if (st.isSymbolicLink()) return p;
	}
	return null;
}

/**
 * One string that changes whenever a directory anywhere under `dir` gains or loses an entry — the
 * mtime of every directory in the tree, in walk order. Directories only: files are not stat'ed, so
 * this costs O(directories), not O(records). What a placed collection's id memo is keyed on, because
 * a root directory's own mtime says nothing about a file dropped three levels down (R4).
 */
export function dirTreeStamps(dir) {
	const out = [];
	const visit = (d) => {
		let st;
		try { st = fs.statSync(d); } catch { return; }
		out.push(`${path.basename(d)}@${st.mtimeMs}`);
		let entries;
		try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
		for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) visit(path.join(d, e.name));
	};
	visit(dir);
	return out.join(',');
}
