// The words a collection answers to on the command line: its declared name and its `singular`
// (compile stamps one on every descriptor — derived by inflection, authorable where inflection is
// wrong — and refuses two collections whose words collide). `dt add task …` and `dt add tasks …`
// are the same call. ⚠ TYPED INPUT ONLY: a reference VALUE inside a record (`tasks/kickoff`) is
// parsed by namespace.js's parseRef against declared names and never learns the singular, so
// `task/kickoff` in a field stays the dangling reference `check` reports it as.
function* words(descriptors) {
	for (const [name, d] of descriptors) {
		yield [name, name];
		if (d?.singular && d.singular !== name) yield [d.singular, name];
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

/**
 * Is this reference SOFT — resolve it if the target is present, ignore it if it is absent?
 *
 * The default is hard, and stays hard: a reference that silently tolerates a missing target is how a
 * typo becomes a permanent dangling link nothing reports. `x-reference-soft: true` is the deliberate
 * opt-out, for a field whose value is a DECLARATION rather than a resolved link — `modules.peer_dependencies`
 * is the case it exists for, and the reason it exists at all: a module names the collections it
 * references but does not own, and the normal state of a module opened on its own is that those
 * collections are not installed. Validated hard, that declaration made the module record it is
 * projected onto uncheckable — there was no state in which an optional cross-module reference passed
 * both gates, because removing the declaration made `compile` fail instead.
 *
 * Read through the same two-place lookup as the target, so the two can never disagree about which
 * node carries the relation (`items` for an array field).
 */
export function refIsSoft(prop) {
	return prop?.['x-reference-soft'] === true || prop?.items?.['x-reference-soft'] === true;
}
