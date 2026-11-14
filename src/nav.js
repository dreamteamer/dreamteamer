// The nav document — `nav.yaml` at the workspace root (cr-dt-008, design §3). One tracked file says how
// the left nav draws: folders, namespace folders and rows in the operator's order, plus the rows not
// drawn at all. Every host (the editor, dt web, install's merge) reads and writes it through these
// functions, so there is one grammar and one writer.
//
// Record layer: a file under the root, parsed and validated against names the caller passes in. It
// never learns what a module or a package is — which module a fragment comes from, and whether it may
// place a name, is judged in nav-fragments.js on the workspace side.
//
//   NavDoc = { tree: Entry[], hidden: string[] }
//   Entry  = string                                         a collection by name
//          | { collection, icon? }                          the long form, when the icon is overridden
//          | { folder, icon?, hidden?, items: Entry[] }     a folder; folders nest
//          | { namespace, icon?, hidden?, items?: Entry[] } a namespace folder; no items = wholly unplaced
import fs from 'node:fs';
import path from 'node:path';
import { load, dump } from './yaml.js';
import { atomicWrite } from './store.js';

export const NAV_FILE = 'nav.yaml';
const HEADER = '# The left nav of this workspace. Drag and drop writes this file; so may you.';

export class NavDocError extends Error {
	constructor(message) {
		super(message);
		this.name = 'NavDocError';
	}
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const collectionOf = (e) => (typeof e === 'string' ? e : isObject(e) && typeof e.collection === 'string' ? e.collection : null);
const isFolder = (e) => isObject(e) && typeof e.folder === 'string';
const isNamespace = (e) => isObject(e) && typeof e.namespace === 'string';

/** The text of a nav.yaml, as a NavDoc. Pure. An empty file, or one with neither key, is an empty document. */
export function parseNavDoc(text) {
	let raw;
	try {
		raw = load(String(text ?? ''));
	} catch (e) {
		throw new NavDocError(`nav.yaml is not valid YAML — ${e.message}`);
	}
	if (raw === undefined || raw === null) return { tree: [], hidden: [] };
	if (!isObject(raw)) throw new NavDocError('nav.yaml is not a mapping');
	const tree = raw.tree ?? [];
	const hidden = raw.hidden ?? [];
	if (!Array.isArray(tree)) throw new NavDocError('nav.yaml: tree must be a list');
	if (!Array.isArray(hidden)) throw new NavDocError('nav.yaml: hidden must be a list');
	return { tree, hidden };
}

/** A NavDoc as the text of a nav.yaml: the header line, `tree`, and `hidden` only when it holds a name. Pure. */
export function serializeNavDoc(doc) {
	const body = { tree: doc?.tree ?? [] };
	if (doc?.hidden?.length) body.hidden = doc.hidden;
	return `${HEADER}\n${dump(body).replace(/\n+$/, '')}\n`;
}

/** `<root>/nav.yaml` parsed, or null when there is none. Any other read failure is a NavDocError. */
export function readNavDoc(root) {
	let text;
	try {
		text = fs.readFileSync(path.join(root, NAV_FILE), 'utf8');
	} catch (e) {
		if (e.code === 'ENOENT') return null;
		throw new NavDocError(`nav.yaml could not be read — ${e.message}`);
	}
	return parseNavDoc(text);
}

/** The one writer every host uses: the whole document, atomically. */
export function writeNavDoc(root, doc) {
	return atomicWrite(path.join(root, NAV_FILE), serializeNavDoc(doc));
}

/** What `dt check` reports about a document: names that resolve to nothing, names listed twice. Never throws. */
export function validateNavDoc(doc, { collections, namespaces = [] } = {}) {
	const known = collections instanceof Set ? collections : new Set(collections ?? []);
	const declared = new Set(namespaces);
	const warnings = [];
	const seen = new Set();
	const twice = new Set();
	const count = (name) => {
		if (seen.has(name) && !twice.has(name)) {
			twice.add(name);
			warnings.push({ warning: `"${name}" is listed twice — it draws at its first place` });
		}
		seen.add(name);
	};
	const walk = (items) => {
		if (!Array.isArray(items)) return;
		for (const e of items) {
			const c = collectionOf(e);
			if (c !== null) {
				if (!known.has(c)) warnings.push({ warning: `unknown collection "${c}"` });
				count(c);
			} else if (isFolder(e)) {
				if (!Array.isArray(e.items)) warnings.push({ warning: `folder "${e.folder}" has no items list` });
				walk(e.items);
			} else if (isNamespace(e)) {
				if (!declared.has(e.namespace)) warnings.push({ warning: `unknown namespace "${e.namespace}"` });
				count(e.namespace);
				walk(e.items);
			} else {
				warnings.push({ warning: `${JSON.stringify(e)} is not a collection, a folder or a namespace` });
			}
		}
	};
	walk(doc?.tree);
	for (const name of doc?.hidden ?? []) {
		if (typeof name !== 'string') { warnings.push({ warning: `hidden holds ${JSON.stringify(name)}, which is not a name` }); continue; }
		// a hidden name is a row or a whole namespace folder
		if (!known.has(name) && !declared.has(name)) warnings.push({ warning: `unknown collection "${name}"` });
		count(name);
	}
	return warnings;
}

/** Every collection the document places: named in the tree at any depth, or hidden. A namespace entry
 *  places nothing by itself (design §3 rule 3) — its collections are placed only by name. */
export function placedNames(doc) {
	const placed = new Set();
	const walk = (items) => {
		if (!Array.isArray(items)) return;
		for (const e of items) {
			const c = collectionOf(e);
			if (c !== null) placed.add(c);
			else if (isFolder(e) || isNamespace(e)) walk(e.items);
		}
	};
	walk(doc?.tree);
	for (const name of doc?.hidden ?? []) if (typeof name === 'string') placed.add(name);
	return placed;
}

/** Every namespace the document names, at any level, or hides. */
function namedNamespaces(doc) {
	const named = new Set();
	const walk = (items) => {
		if (!Array.isArray(items)) return;
		for (const e of items) {
			if (isNamespace(e)) named.add(e.namespace);
			if (isFolder(e) || isNamespace(e)) walk(e.items);
		}
	};
	walk(doc?.tree);
	for (const name of doc?.hidden ?? []) if (typeof name === 'string') named.add(name);
	return named;
}

/**
 * A module's fragment merged into the document: it only ever ADDS what the document does not place yet,
 * and never moves what is placed. Pure — neither input is mutated, and when nothing is placed the SAME
 * `doc` object comes back, so a caller can tell "nothing to write" by identity. The fragment's `hidden`
 * is ignored: a module never hides a row.
 *
 * Per fragment level, against the document level at the same depth: a row not placed is appended; a
 * folder merges into the same-label folder AT THE SAME LEVEL, else into a new one appended only when it
 * placed something; a namespace merges into the same namespace's entry at the same level, else — when
 * the document names that namespace nowhere — into a new entry; named at another level, nothing is
 * created and its rows stay unplaced (the drawing puts them inside that namespace's folder).
 */
export function mergeFragment(doc, fragment, { placed } = {}) {
	const taken = new Set(placed ?? placedNames(doc));
	const named = namedNamespaces(doc);
	const placedNow = [];

	const mergeLevel = (level, items) => {
		let out = level;
		const own = () => { if (out === level) out = [...level]; return out; };
		for (const f of Array.isArray(items) ? items : []) {
			const c = collectionOf(f);
			if (c !== null) {
				if (taken.has(c)) continue;
				taken.add(c);
				placedNow.push(c);
				own().push(typeof f === 'object' && f.icon != null ? { collection: c, icon: f.icon } : c);
			} else if (isFolder(f)) {
				const i = out.findIndex((e) => isFolder(e) && e.folder === f.folder);
				if (i >= 0) {
					const current = Array.isArray(out[i].items) ? out[i].items : [];
					const merged = mergeLevel(current, f.items);
					if (merged !== current) own()[i] = { ...out[i], items: merged };
				} else {
					const merged = mergeLevel([], f.items);
					if (merged.length) own().push({ folder: f.folder, ...decor(f), items: merged });
				}
			} else if (isNamespace(f)) {
				const i = out.findIndex((e) => isNamespace(e) && e.namespace === f.namespace);
				if (i >= 0) {
					const current = Array.isArray(out[i].items) ? out[i].items : [];
					const merged = mergeLevel(current, f.items);
					if (merged !== current) own()[i] = { ...out[i], items: merged };
				} else if (!named.has(f.namespace)) {
					const merged = mergeLevel([], f.items);
					const itemless = !Array.isArray(f.items) || f.items.length === 0;
					if (merged.length || itemless) {
						named.add(f.namespace);
						own().push({ namespace: f.namespace, ...decor(f), ...(merged.length ? { items: merged } : {}) });
					}
				}
			}
		}
		return out;
	};

	const tree = Array.isArray(doc?.tree) ? doc.tree : [];
	const merged = mergeLevel(tree, fragment?.tree);
	if (merged === tree) return { doc, placedNow };
	return { doc: { tree: merged, hidden: [...(doc?.hidden ?? [])] }, placedNow };
}

const decor = (e) => ({ ...(e.icon != null ? { icon: e.icon } : {}), ...(e.hidden === true ? { hidden: true } : {}) });
