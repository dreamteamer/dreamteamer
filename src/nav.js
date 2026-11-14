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
/** 'collection' · 'folder' · 'namespace', or null for an entry of none of the four shapes. */
const kindOf = (e) => (typeof e === 'string' || typeof e?.collection === 'string' ? 'collection'
	: typeof e?.folder === 'string' ? 'folder'
		: typeof e?.namespace === 'string' ? 'namespace' : null);
const nameOf = (e) => (typeof e === 'string' ? e : e.collection);

/** Every entry of a tree level and the levels inside it, depth first, with its kind. */
function eachEntry(items, visit) {
	if (!Array.isArray(items)) return;
	for (const e of items) {
		const kind = kindOf(e);
		visit(e, kind);
		if (kind === 'folder' || kind === 'namespace') eachEntry(e.items, visit);
	}
}

/** The text of a nav.yaml, as a NavDoc. Pure. An empty file, or one with neither key, is an empty document. */
export function parseNavDoc(text) {
	let raw;
	try {
		raw = load(String(text));
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
	const body = { tree: doc.tree };
	if (doc.hidden.length) body.hidden = doc.hidden;
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
export function validateNavDoc(doc, { collections, namespaces = [] }) {
	const declared = new Set(namespaces);
	const warnings = [];
	const warn = (warning) => warnings.push({ warning });
	const seen = new Set();
	const twice = new Set();
	const count = (name) => {
		if (seen.has(name) && !twice.has(name)) { twice.add(name); warn(`"${name}" is listed twice — it draws at its first place`); }
		seen.add(name);
	};
	eachEntry(doc.tree, (e, kind) => {
		if (kind === 'collection') {
			if (!collections.has(nameOf(e))) warn(`unknown collection "${nameOf(e)}"`);
			count(nameOf(e));
		} else if (kind === 'namespace') {
			if (!declared.has(e.namespace)) warn(`unknown namespace "${e.namespace}"`);
			count(e.namespace);
		} else if (kind === 'folder') {
			if (!Array.isArray(e.items)) warn(`folder "${e.folder}" has no items list`);
		} else warn(`${JSON.stringify(e)} is not a collection, a folder or a namespace`);
	});
	for (const name of doc.hidden) {
		if (typeof name !== 'string') { warn(`hidden holds ${JSON.stringify(name)}, which is not a name`); continue; }
		// a hidden name is a row or a whole namespace folder
		if (!collections.has(name) && !declared.has(name)) warn(`unknown collection "${name}"`);
		count(name);
	}
	return warnings;
}

/** The names of one kind of entry in the tree, at any depth, plus every hidden name. */
function namesIn(doc, wanted) {
	const out = new Set();
	eachEntry(doc.tree, (e, kind) => { if (kind === wanted) out.add(kind === 'collection' ? nameOf(e) : e.namespace); });
	for (const name of doc.hidden) if (typeof name === 'string') out.add(name);
	return out;
}

/** Every collection the document places: named in the tree at any depth, or hidden. A namespace entry
 *  places nothing by itself (design §3 rule 3) — its collections are placed only by name. */
export const placedNames = (doc) => namesIn(doc, 'collection');

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
export function mergeFragment(doc, fragment, { placed = placedNames(doc) } = {}) {
	const taken = new Set(placed);
	const named = namesIn(doc, 'namespace');
	const placedNow = [];
	// one tree level: `level` is copied on its first change, so an untouched level comes back as itself
	const mergeLevel = (level, items) => {
		let out = level;
		const own = () => { if (out === level) out = [...level]; return out; };
		const into = (i, e) => { // merge e's items into out[i]'s
			const current = Array.isArray(out[i].items) ? out[i].items : [];
			const merged = mergeLevel(current, e.items);
			if (merged !== current) own()[i] = { ...out[i], items: merged };
		};
		for (const f of Array.isArray(items) ? items : []) {
			const kind = kindOf(f);
			if (kind === 'collection') {
				const c = nameOf(f);
				if (taken.has(c)) continue;
				taken.add(c);
				placedNow.push(c);
				own().push(f.icon == null ? c : { collection: c, icon: f.icon });
			} else if (kind === 'folder') {
				const i = out.findIndex((e) => kindOf(e) === 'folder' && e.folder === f.folder);
				if (i >= 0) { into(i, f); continue; }
				const merged = mergeLevel([], f.items);
				if (merged.length) own().push({ folder: f.folder, ...decor(f), items: merged });
			} else if (kind === 'namespace') {
				const i = out.findIndex((e) => kindOf(e) === 'namespace' && e.namespace === f.namespace);
				if (i >= 0) { into(i, f); continue; }
				if (named.has(f.namespace)) continue; // named at another level: its rows draw inside it
				const merged = mergeLevel([], f.items);
				if (!merged.length && f.items?.length) continue;
				named.add(f.namespace);
				own().push({ namespace: f.namespace, ...decor(f), ...(merged.length ? { items: merged } : {}) });
			}
		}
		return out;
	};
	const merged = mergeLevel(doc.tree, fragment.tree);
	return { doc: merged === doc.tree ? doc : { tree: merged, hidden: [...doc.hidden] }, placedNow };
}

const decor = (e) => ({ ...(e.icon != null ? { icon: e.icon } : {}), ...(e.hidden === true ? { hidden: true } : {}) });
