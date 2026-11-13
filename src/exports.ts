// The exports manifest (cr-dt-004) — `dreamteamer-exports.json` at a repo root: per id that repo's own
// records name and no file of the repo holds, a display label and the package name of the workspace that
// held it when the entry was written. A reader reads a layer WITHOUT that layer's own layers, so this is
// the repo's proof that such an id exists elsewhere. Written only by `dt exports`; `check` reads it.
//
// Record layer: pure over the roots, descriptors and the facts compile recorded in the runtime — it never
// reads package.json. One walk of a repo's references (`outsideRefs`) and one judgement (`regenerate`)
// serve `check`, `dt exports` and the migration script, so the three cannot disagree.
import fs from 'node:fs';
import path from 'node:path';
import { walk } from './records.ts';
import { parseRef } from './namespace.ts';
import { storageOf, fieldsOf, targetsOf, isSoft } from './descriptor.ts';
import type { Storage } from './types.ts';

export const EXPORTS_FILE = 'dreamteamer-exports.json';

/** The manifest of the repo rooted at `dir` — `{ <collection>: { <id>: { label, from? } } }` — or null
 *  when it has none. An unparseable file throws, naming its path: it is never read as empty. */
export function readExports(dir) {
	const file = path.join(dir, EXPORTS_FILE);
	if (!fs.existsSync(file)) return null;
	try { return JSON.parse(fs.readFileSync(file, 'utf8')).references ?? {}; } catch (e) {
		throw new Error(`${EXPORTS_FILE} does not parse (${e.message}) — resolve it by hand: keep every entry line of both sides, then run dt exports`);
	}
}

/** The file's bytes: tab-indented, collections and ids sorted, one line per entry, nothing time- or
 *  version-dependent — so an unchanged manifest regenerates byte for byte. `null` for an empty one. */
export function serializeExports(refs) {
	const colls = Object.keys(refs).filter((c) => Object.keys(refs[c]).length).sort();
	if (!colls.length) return null;
	const entry = (e) => `{ "label": ${JSON.stringify(e.label)}${e.from ? `, "from": ${JSON.stringify(e.from)}` : ''} }`;
	const blocks = colls.map((c) => `\t\t${JSON.stringify(c)}: {\n${Object.keys(refs[c]).sort().map((id) => `\t\t\t${JSON.stringify(id)}: ${entry(refs[c][id])}`).join(',\n')}\n\t\t}`);
	return `{\n\t"dreamteamer_exports": 1,\n\t"references": {\n${blocks.join(',\n')}\n\t}\n}\n`;
}

/** Every hard-reference field of a descriptor's fields, nested ones included: `[path, targets, soft]`. */
export function collectRefFields(fields, prefix = []) {
	const out = [];
	for (const [key, f] of Object.entries<any>(fields ?? {})) {
		if (!f || typeof f !== 'object') continue;
		const p = [...prefix, key];
		const targets = targetsOf(f);
		if (targets) out.push([p, targets, isSoft(f)]);
		if (f.type === 'object' && f.fields) out.push(...collectRefFields(f.fields, p));
	}
	return out;
}

/** Every leaf value at a field path, arrays flattened. */
export function* valuesAt(obj, fieldPath) {
	let vals = [obj];
	for (const key of fieldPath) vals = vals.flatMap((v) => (Array.isArray(v) ? v : [v])).flatMap((v) => (v && typeof v === 'object' ? [v[key]] : []));
	for (const v of vals.flat(Infinity)) if (v != null) yield v;
}

/** Is every file under `dataDir` inside one of the `reads` folders (paths relative to `root`)? Judged on
 *  the disk NOW, so a folder a pull added after compile makes the repo incomplete without a recompile. */
function readsAll(root, dataDir, reads) {
	const abs = path.join(root, dataDir);
	if (!fs.existsSync(abs)) return true;
	const prefixes = reads.map((r) => path.join(root, r) + path.sep);
	for (const f of walk(abs)) if (!prefixes.some((p) => f.startsWith(p))) return false;
	return true;
}

/**
 * The one context every judgement uses. `layers` are the runtime's layer facts (null: an older runtime —
 * nothing is known, so no layer is complete and no layer holder is seen); `own` this workspace's package
 * name. A repo is named by its layer name, the write root by null.
 */
export function exportsContext({ root, descriptors, own, layers, dataPath = 'data' }) {
	const facts = new Map<string, any>((layers ?? []).map((l) => [l.name, l]));
	const rootsOf = (coll) => {
		const d = descriptors.get(coll);
		if (!d) return [];
		return storageOf(d).roots.map((r) => {
			const fact = r.layer ? facts.get(r.layer) : null;
			return { layer: r.layer ?? null, package: r.layer ? fact?.package ?? null : own, present: !r.layer || (!!fact && fs.existsSync(path.join(root, r.repo))) };
		});
	};
	const complete = (layer) => {
		if (layer) { const l = facts.get(layer); return !!l && !l.narrowed && readsAll(root, l.data, l.reads); }
		const reads = [];
		for (const d of descriptors.values()) {
			if (storageOf(d).unavailable) return false;
			if ((storageOf(d) as Storage & { base?: string }).base !== 'runtime' && !path.isAbsolute(storageOf(d).path) && !storageOf(d).path.includes('${')) reads.push(storageOf(d).path);
		}
		return readsAll(root, dataPath, reads);
	};
	return { own, rootsOf, complete, packageOf: (layer) => (layer ? facts.get(layer)?.package ?? null : own), rootOf: (layer) => (layer ? path.join(root, facts.get(layer)?.root ?? path.join('git_modules', layer)) : root) };
}

/** Does this context read the entry's holder for its collection — a root of that collection, on disk,
 *  whose package is the entry's `from`? An entry with no holder is seen by no context. */
export function sees(entry, coll, ctx) {
	return !!entry?.from && ctx.rootsOf(coll).some((r) => r.present && r.package === entry.from);
}

/**
 * A repo's outside references: every value of a hard, non-mirror reference field on one of its records
 * that names an id the repo does not hold. `records` yields `{ collection, id, fields, descriptor }`;
 * `held(coll, id)` says the repo holds it; `resolve(coll, id)` answers `{ label, from }` or null.
 * @returns {Map<string, { collection, id, resolved, referrers: string[] }>} keyed `<collection>/<id>`
 */
export function outsideRefs({ records, held, resolve, namespaces }) {
	const out = new Map();
	for (const { collection, id, fields, descriptor } of records) {
		for (const [fieldPath, targets, soft] of collectRefFields(fieldsOf(descriptor))) {
			if (soft || (fieldPath.length === 1 && fieldsOf(descriptor)[fieldPath[0]]?.mirror_of !== undefined)) continue;
			for (const value of valuesAt(fields, fieldPath)) {
				const ref = typeof value === 'string' && !value.startsWith('@') ? parseRef(value, namespaces) : null;
				if (!ref || (targets !== '*' && !targets.includes(ref.collection)) || held(ref.collection, ref.id)) continue;
				const key = `${ref.collection}/${ref.id}`;
				if (!out.has(key)) out.set(key, { collection: ref.collection, id: ref.id, resolved: resolve(ref.collection, ref.id), referrers: [] });
				out.get(key).referrers.push(`${collection}/${id}`);
			}
		}
	}
	return out;
}

/**
 * The manifest `dt exports` would write for `repo` in this context, and why — design §3's rules:
 * add an outside reference that resolves here; refresh a label only where the entry's holder is seen
 * and still has the id (its `from` never changes); fill a holder-less entry whose id resolves here;
 * drop an entry for an id the repo now holds, one whose seen holder lost the id, and — only where this
 * context reads every record of the repo — one nothing references; keep everything else as written.
 */
export function regenerate({ current, outside, ctx, repo, held }) {
	const next = {};
	const changes = [];
	const put = (c, id, e) => { (next[c] ??= {})[id] = e; };
	const complete = ctx.complete(repo);
	for (const [c, ids] of Object.entries(current ?? {})) {
		for (const [id, e] of Object.entries(ids)) {
			const ref = `${c}/${id}`;
			const o = outside.get(ref);
			const why = held(c, id) ? 'held by the repo itself'
				: !o && complete ? 'no record references it'
				: o && !o.resolved && sees(e, c, ctx) ? `its holder ${e.from} no longer has it`
				: null;
			if (why) { changes.push({ ref, kind: 'drop', why }); continue; }
			if (o?.resolved && !e.from) { put(c, id, o.resolved); changes.push({ ref, kind: 'fill', why: `held by ${o.resolved.from}` }); continue; }
			if (o?.resolved && o.resolved.from === e.from && sees(e, c, ctx) && o.resolved.label !== e.label) {
				put(c, id, { label: o.resolved.label, from: e.from });
				changes.push({ ref, kind: 'refresh', why: `label "${e.label}" is now "${o.resolved.label}"` });
				continue;
			}
			put(c, id, e);
		}
	}
	for (const [ref, o] of outside) {
		if (!o.resolved || current?.[o.collection]?.[o.id]) continue;
		put(o.collection, o.id, o.resolved);
		changes.push({ ref, kind: 'add', why: `named by ${o.referrers[0]}${o.referrers.length > 1 ? ` +${o.referrers.length - 1}` : ''}` });
	}
	return { next, changes };
}

/** A manifest is stale exactly when `regenerate` would change or drop one of its existing entries. */
export const isStale = (changes) => changes.some((c) => c.kind !== 'add');
