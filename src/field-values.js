// distinct values actually present in a collection's field.
//
// Why this exists: a filter (or a command-binding validator) can only offer a dropdown when
// something tells it the value set. `enum` in the descriptor does that — but most string fields
// aren't enums and never will be. `meetings.status` and `meetings.visibility` are plain
// `type: string`, so the filter builder correctly fell back to a free-text box and the operator
// had to know the vocabulary by heart (operator 2026-07-28: "still no dropdown for many things,
// visibility, status — why?").
//
// The data already knows. This derives the vocabulary from the records themselves, so every
// low-cardinality field becomes selectable with no schema change and no risk of `check` failing
// on a value that predates an enum someone added later.
import { bodyField } from './store.js';

/** Above this many distinct values a dropdown stops being a dropdown — report and stop counting. */
export const DEFAULT_LIMIT = 50;

/**
 * `{ collection, field, values: [{value, count}], total, truncated }` — most-used first, then
 * alphabetical, so the dropdown leads with what the operator actually uses.
 *
 * Array-valued fields (tags, attendees) contribute each ENTRY, not the array: filtering
 * `attendees` by `contacts/ada` is the useful question, and `matchesFilter` already gives array
 * fields containment semantics for `_eq`/`_in`, so the two halves agree.
 *
 * Bodies are skipped outright — a markdown body has one distinct value per record and counting
 * them is pure waste. Objects are skipped too: there is no sane dropdown entry for a subtree.
 */
export function distinctValues(store, collection, field, { limit = DEFAULT_LIMIT } = {}) {
	const d = store.descriptor(collection);
	const prop = d.schema?.properties?.[field];
	if (!prop && field !== 'id') {
		throw new Error(`unknown field "${field}" on ${collection} (known: ${Object.keys(d.schema?.properties ?? {}).join(', ')})`);
	}
	if (prop?.['x-body']) return { collection, field, values: [], total: 0, truncated: false, skipped: 'body' };
	const isObject = prop?.type === 'object' || prop?.items?.type === 'object';
	if (isObject) return { collection, field, values: [], total: 0, truncated: false, skipped: 'object' };

	// An enum already IS the vocabulary — hand it back verbatim (counts omitted: the schema's
	// answer must not shrink just because no record happens to use a legal value yet).
	const declared = prop?.enum ?? prop?.items?.enum;
	if (Array.isArray(declared) && declared.length) {
		return { collection, field, values: declared.map((value) => ({ value, count: null })), total: declared.length, truncated: false, source: 'enum' };
	}

	const bf = bodyField(d);
	const counts = new Map();
	for (const { id, fields } of store.readAll(collection)) {
		const raw = field === 'id' ? id : fields[field];
		if (raw == null || raw === '' || (bf && field === bf)) continue;
		for (const v of Array.isArray(raw) ? raw : [raw]) {
			if (v == null || v === '' || typeof v === 'object') continue;
			counts.set(v, (counts.get(v) ?? 0) + 1);
		}
	}

	const sorted = [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
		.map(([value, count]) => ({ value, count }));

	return {
		collection,
		field,
		values: sorted.slice(0, limit),
		total: sorted.length,
		truncated: sorted.length > limit,
		source: 'data',
	};
}
