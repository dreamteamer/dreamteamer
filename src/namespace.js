// NAMESPACES — how a collection name is scoped, and how a reference splits back apart.
//
// A namespace is a slash-delimited prefix on a collection name: `health/doctors` is the collection
// `doctors` in the namespace `health`, and its records live under `data/health/doctors/`. A
// reference to one of those records is `health/doctors/dana-levi`.
//
// ⚠ THE WHOLE PROBLEM IN ONE LINE: an id is ALSO a slash-delimited path (`meetings/2026/07/kickoff`
// is one collection and a three-segment id), so `a/b/c` is either collection `a` + id `b/c` or
// collection `a/b` + id `c`, and nothing about the STRING says which.
//
// So namespaces are DECLARED, in the workspace package.json:
//
//     "dreamteamer": { "namespaces": ["health", "finance", "work/clients"] }
//
// and every split consults that closed set, longest match first. The alternative — inferring the
// boundary from whichever collections happen to exist — was rejected: it makes the meaning of a
// reference depend on the current descriptor set, so installing a module could silently re-point
// references in records nobody edited. A declared list also turns the dangerous case (a namespace
// whose name collides with a collection's) into a compile error instead of a longest-prefix win.
//
// The DEFAULT namespace is the empty prefix. `tasks/kickoff` is a reference into it, `data/tasks/`
// is where it lives, and that is exactly what every workspace already has — which is why adopting
// namespaces migrates nothing. `default` is reserved precisely so there is never a second spelling
// for the same collection.
//
// This module is deliberately PURE — the declared list arrives as an argument. compile validates it
// and writes it into the manifest; runtime.js hands it to the record layer. Nothing here reads a
// file, so all of it is unit-testable without a workspace.

/** Never a namespace: it would give the default namespace a second, prefixed spelling. */
export const RESERVED_NAMESPACES = new Set(['default']);

/** One segment of a namespace or collection name: the id-safe alphabet the rest of the engine uses. */
const SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The declared list, cleaned and ordered for prefix matching: de-duplicated, slash-trimmed, and
 * sorted LONGEST FIRST so a nested namespace (`work/clients`) is tested before its parent (`work`).
 * Order is the correctness property here, not a nicety — parent-first would claim `work/clients/acme`
 * for the namespace `work`, making the collection `clients` and the id `acme` on a workspace where
 * `work/clients` is the namespace and the collection is something else entirely.
 */
export function normalizeNamespaces(list) {
	if (!Array.isArray(list)) return [];
	const seen = new Set();
	for (const raw of list) {
		if (typeof raw !== 'string') continue;
		const ns = raw.trim().replace(/^\/+|\/+$/g, '');
		if (ns) seen.add(ns);
	}
	return [...seen].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/**
 * Everything wrong with a declared list, as sentences — or `[]`. `collectionNames` is every compiled
 * collection's qualified name, which is what makes the collision check possible at all.
 *
 * compile calls this and fails on a non-empty result. It is a separate function from the compiler so
 * the rules can be tested directly, and so the error text lives beside the semantics it protects.
 */
export function namespaceProblems(namespaces, collectionNames = []) {
	const problems = [];
	const names = new Set(collectionNames);
	for (const ns of namespaces) {
		const segments = ns.split('/');
		for (const seg of segments) {
			if (RESERVED_NAMESPACES.has(seg)) {
				problems.push(`namespace "${ns}": "${seg}" is reserved — the default namespace is the EMPTY prefix, so a collection in it is spelled \`tasks\`, never \`default/tasks\`.`);
			} else if (!SEGMENT.test(seg)) {
				problems.push(`namespace "${ns}": segment "${seg}" must be lowercase alphanumeric with single hyphens (it becomes a folder name and part of every reference).`);
			}
		}
		// The collision that makes a slash-delimited namespace dangerous: with BOTH a namespace
		// `health` and a collection `health`, the reference `health/doctors/dana-levi` is a record of
		// collection `health/doctors` AND a record of collection `health` with the nested id
		// `doctors/dana-levi`. Longest-match would silently pick the first and make the second
		// unreferenceable. Refused up front instead.
		if (names.has(ns)) {
			problems.push(`namespace "${ns}" collides with the collection of the same name — a reference like "${ns}/x/y" would be ambiguous. Rename one.`);
		}
	}
	return problems;
}

/** `health` + `doctors` → `health/doctors`; the default namespace (empty) → `doctors`. */
export function qualify(namespace, name) {
	const ns = String(namespace ?? '').replace(/^\/+|\/+$/g, '');
	return ns ? `${ns}/${name}` : String(name);
}

/**
 * The declared namespace a qualified collection name sits in, or `''` for the default namespace.
 * Matched against the declared list rather than by cutting at the last slash, because a collection
 * name is only namespaced if its prefix was actually declared — see `unqualifiedProblems`.
 */
export function namespaceOf(qualified, namespaces) {
	for (const ns of namespaces) if (qualified.startsWith(ns + '/')) return ns;
	return '';
}

/** The bare collection name inside its namespace: `health/doctors` → `doctors`. */
export function baseNameOf(qualified, namespaces) {
	const ns = namespaceOf(qualified, namespaces);
	return ns ? qualified.slice(ns.length + 1) : qualified;
}

/**
 * A collection name in the singular — what one RECORD of it is called. `doctors` → `doctor`,
 * `stories` → `story`, `finance` → `financ`… which is why this is only ever applied to a name the
 * author can override.
 *
 * It lives here beside `baseNameOf` because three subsystems have to agree on it and they sit in
 * different layers: `compile` derives an absent `storage.suffix` from it, `collections add` writes
 * the same value into a new descriptor, and `rename-collection` asks `oldSuffix === singular(oldBase)`
 * to decide whether a suffix was DERIVED and may be re-derived. Two spellings of this rule would make
 * that last question answer wrong on the exact records it is protecting.
 */
export function singular(name) {
	return name.endsWith('ies') ? name.slice(0, -3) + 'y' : name.endsWith('s') ? name.slice(0, -1) : name;
}

/**
 * A collection name carrying a slash whose prefix is NOT declared, which is the silent-failure this
 * whole module exists to prevent: every reference to it would split at the first slash, name a
 * collection that does not exist, and dangle. Returns problems as sentences, or `[]`.
 */
export function unqualifiedProblems(collectionNames, namespaces) {
	const problems = [];
	for (const name of collectionNames) {
		if (!name.includes('/')) continue;
		if (namespaceOf(name, namespaces)) continue;
		const guess = name.slice(0, name.lastIndexOf('/'));
		problems.push(`collection "${name}" is namespaced, but "${guess}" is not declared — add it to \`dreamteamer.namespaces\` in package.json, or every reference to this collection will split at the first slash and dangle.`);
	}
	return problems;
}

/**
 * Split a reference into `{ collection, id }`, or `null` when it is not a reference shape.
 *
 * THE one place the boundary is decided. Everything that parses a reference — the store's write-time
 * check, `check`'s report, the extension's go-to-definition — goes through here, so a namespace can
 * never mean one thing on write and another on read.
 */
export function parseRef(ref, namespaces = []) {
	if (typeof ref !== 'string' || !ref) return null;
	for (const ns of namespaces) {
		if (!ref.startsWith(ns + '/')) continue;
		const rest = ref.slice(ns.length + 1);
		const slash = rest.indexOf('/');
		// `health/doctors` alone names a COLLECTION, not a record — there is no id, so it is not a
		// reference. Falling through to the unnamespaced split would call it collection `health`,
		// which is the ambiguity this module refuses everywhere else.
		if (slash < 1 || slash === rest.length - 1) return null;
		return { collection: `${ns}/${rest.slice(0, slash)}`, id: rest.slice(slash + 1) };
	}
	const slash = ref.indexOf('/');
	if (slash < 1 || slash === ref.length - 1) return null;
	return { collection: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

/**
 * The folder a collection's records belong in, workspace-relative and WITHOUT any module prefix
 * (compile adds that for an `owns-data` module). The namespace becomes real directory nesting, which
 * is the point: `health/doctors` lands in `data/health/doctors/` rather than beside `data/tasks/`.
 */
export function defaultStoragePath(qualified, namespaces, dataPath = 'data') {
	const ns = namespaceOf(qualified, namespaces);
	const base = ns ? qualified.slice(ns.length + 1) : qualified;
	return ns ? `${dataPath}/${ns}/${base}` : `${dataPath}/${base}`;
}

/**
 * Storage paths that swallow each other, as sentences — or `[]`. `entries` is `[{name, path}]`.
 *
 * ⚠ MEASURED DATA LOSS, not a hypothetical. Give collection A the path `data/health` and collection
 * B `data/health/doctors`, and A's recursive walk indexes B's records as its own: `dt A list` prints
 * B's records under A's name, `check` reports B's fields as unknown fields of A, and a write through
 * A can overwrite a record of B. compile reported ✔ through all of it, because nothing ever compared
 * two collections' paths. Namespaces make near-misses like this ordinary, so the check is no longer
 * optional.
 *
 * Segment-wise on purpose: `data/health` must not flag `data/health-notes`.
 */
export function storageOverlaps(entries) {
	const problems = [];
	const sorted = [...entries].filter((e) => e.path).sort((a, b) => a.path.localeCompare(b.path));
	for (const outer of sorted) {
		for (const inner of sorted) {
			if (outer === inner || outer.base !== inner.base) continue;
			if (!inner.path.startsWith(outer.path + '/')) continue;
			problems.push(`collection "${inner.name}" stores records under "${inner.path}", which is INSIDE "${outer.name}"'s folder "${outer.path}" — the outer collection would index the inner one's records as its own. Give one of them a folder of its own.`);
		}
	}
	return problems;
}
