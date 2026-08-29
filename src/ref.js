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
 * The declared target set of a reference property: '*', an array of collection names, or null when
 * the property is not a reference. `x-reference` accepts a scalar or a LIST of targets; this is the
 * ONE place that widening is decoded — every consumer reads targets through here (or applies the
 * identical one-liner where importing would cross a layer), so the two spellings can never mean
 * different things in different subsystems.
 *
 * This function normalizes SPELLING only, not shape: `[]` decodes to `[]` and `''` decodes to
 * `['']`, neither of which is a valid target set. Whether the array is non-empty, every member is a
 * non-empty string, and `'*'` never hides inside a list is compile's job (see compile.js's
 * validation of each union member) — a consumer calling this at runtime is reading an
 * already-compiled, already-validated descriptor and can rely on the shape holding, but should not
 * re-derive that guarantee from this decoder.
 */
export function refTargetsOf(prop) {
	const raw = prop?.['x-reference'] ?? prop?.items?.['x-reference'];
	if (raw == null) return null;
	if (raw === '*') return '*';
	return Array.isArray(raw) ? raw : [raw];
}
