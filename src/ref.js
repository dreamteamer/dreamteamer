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
