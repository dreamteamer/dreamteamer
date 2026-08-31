// Relations, decoded ONCE. A relation is one owner field carrying `x-inverse` in the compiled
// runtime — compile is the only producer of that shape (both source spellings normalize to it),
// so check, the store's mirror maintenance, `dt relations`, rebuild and presentation all read
// through here and can never disagree about what a relation is.
import { refTargetsOf } from './ref.js';

export function relationsOf(descriptors) {
	const out = [];
	for (const [name, d] of descriptors) {
		for (const [field, prop] of Object.entries(d.schema?.properties ?? {})) {
			if (!prop || typeof prop !== 'object') continue;
			const holder = (prop.items && typeof prop.items === 'object') ? prop.items : prop;
			const inverse = holder['x-inverse'];
			if (!inverse) continue;
			const targets = refTargetsOf(prop);
			if (!targets || targets === '*') continue; // compile refuses these; defensive at runtime
			const list = prop.type === 'array';
			const unique = holder['x-unique'] === true;
			for (const target of targets) {
				out.push({
					owner: name, field, target,
					mirror: typeof inverse === 'string' ? inverse : inverse.field,
					list, unique,
					onDelete: holder['x-on-delete'] ?? 'restrict',
					kind: list ? 'm2m' : unique ? 'o2o' : 'm2o',
				});
			}
		}
	}
	return out;
}

/** What each target record's mirror SHOULD hold, computed from the owning side.
 *  Sorted arrays (ids are usually date-prefixed, so that reads chronological); a scalar for unique. */
export function expectedMirrors(rel, ownerRecords) {
	const exp = new Map();
	for (const { id, fields } of ownerRecords) {
		const raw = fields?.[rel.field];
		const refs = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
		for (const ref of refs) {
			if (typeof ref !== 'string' || !ref.startsWith(`${rel.target}/`)) continue;
			const targetId = ref.slice(rel.target.length + 1);
			const self = `${rel.owner}/${id}`;
			if (rel.unique) exp.set(targetId, self);
			// DEDUPED, like the set the store writes (store.js applyMirrorEdits) — an owner may name
			// one target twice (an authored reference array declares no uniqueItems, so `dt add x
			// --meetings m1,m1` is accepted). Appending blind made this the ONE expectation nothing
			// else agreed with: check called the store's correct mirror stale, and the repair its
			// message names — `relations rebuild` — wrote the duplicate it was run to remove.
			else exp.set(targetId, [...new Set([...(exp.get(targetId) ?? []), self])].sort());
		}
	}
	return exp;
}
