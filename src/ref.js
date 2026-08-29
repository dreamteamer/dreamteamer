// split "<collection>/<id>" against the DECLARED collections — longest prefix at a "/" boundary,
// because both collection names and ids may contain slashes (namespaces; path-shaped ids).
export function splitRef(descriptors, ref) {
	let best = null;
	for (const name of descriptors.keys()) {
		if (ref === name || ref.startsWith(name + '/')) {
			if (!best || name.length > best.length) best = name;
		}
	}
	if (!best) throw new Error(`unknown collection in reference "${ref}" (known: ${[...descriptors.keys()].sort().join(', ')})`);
	if (ref === best) throw new Error(`reference "${ref}" names a collection but no record id`);
	return { collection: best, id: ref.slice(best.length + 1) };
}

/**
 * The declared target set of a reference property: '*', a non-empty array of collection names, or
 * null when the property is not a reference. `x-reference` accepts a scalar or a LIST of targets;
 * this is the ONE place that widening is decoded — every consumer reads targets through here (or
 * applies the identical one-liner where importing would cross a layer), so the two spellings can
 * never mean different things in different subsystems.
 */
export function refTargetsOf(prop) {
	const raw = prop?.['x-reference'] ?? prop?.items?.['x-reference'];
	if (raw == null) return null;
	if (raw === '*') return '*';
	return Array.isArray(raw) ? raw : [raw];
}
