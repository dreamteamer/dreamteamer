import { singularOf } from './descriptor.js';
// The words a collection answers to on the command line: its declared name and its `singular`
// (compile stamps one on every descriptor — derived by inflection, authorable where inflection is
// wrong — and refuses two collections whose words collide). `dt add task …` and `dt add tasks …`
// are the same call. ⚠ TYPED INPUT ONLY: a reference VALUE inside a record (`tasks/kickoff`) is
// parsed by namespace.js's parseRef against declared names and never learns the singular, so
// `task/kickoff` in a field stays the dangling reference `check` reports it as.
function* words(descriptors) {
	for (const [name, d] of descriptors) {
		yield [name, name];
		const word = singularOf(d);
		if (word && word !== name) yield [word, name];
	}
}

/** The declared collection a typed word names — the name itself or its singular — else null. */
export function canonicalCollection(descriptors, word) {
	if (descriptors.has(word)) return word;
	for (const [w, name] of words(descriptors)) if (w === word) return name;
	return null;
}

// split "<collection>/<id>" against the DECLARED collections and their singulars — longest prefix
// at a "/" boundary, because both collection names and ids may contain slashes (namespaces;
// path-shaped ids). The collection returned is always the declared NAME, whichever word was typed.
export function splitRef(descriptors, ref) {
	let best = null;
	let bestName = null;
	for (const [w, name] of words(descriptors)) {
		if (ref === w || ref.startsWith(w + '/')) {
			if (!best || w.length > best.length) { best = w; bestName = name; }
		}
	}
	if (!best) throw new Error(`unknown collection in reference "${ref}" (known: ${[...descriptors.keys()].sort().join(', ')})`);
	if (ref === best) throw new Error(`reference "${ref}" names a collection but no record id`);
	return { collection: bestName, id: ref.slice(best.length + 1) };
}


