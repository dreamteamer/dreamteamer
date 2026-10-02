// Relations, decoded ONCE. A relation is a mirror field (`mirror_of: <owner field>`) in the compiled
// runtime, so check, the store's mirror maintenance, `dt relations`, rebuild and presentation all
// read through here and can never disagree about what a relation is.
import { fieldsOf, targetsOf } from './descriptor.js';

export function relationsOf(descriptors) {
	const out = [];
	// A relation is declared once, on the MIRROR: a field `mirror_of: f` with `type: O` on collection T
	// is the generated far side of O's reference `f`. The row is keyed by the owner, as every reader
	// (the store's maintenance, check's expectations, `dt relations`) has always asked it.
	for (const [target, d] of descriptors) {
		for (const [mirror, m] of Object.entries(fieldsOf(d))) {
			if (m.mirror_of === undefined) continue;
			const owner = targetsOf(m)?.[0];
			const od = owner && descriptors.get(owner);
			if (!od) continue; // an uninstalled peer: the mirror is inert
			const f = fieldsOf(od)[m.mirror_of];
			if (!f) continue; // compile refuses this; defensive at runtime
			const list = f.many === true;
			const unique = f.unique === true && !list;
			out.push({
				owner, field: m.mirror_of, target, mirror,
				list, unique,
				onDelete: f.on_delete ?? 'restrict',
				kind: list ? 'm2m' : unique ? 'o2o' : 'm2o',
			});
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
