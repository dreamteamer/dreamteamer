// Manual ordering keys. Named for the ALGORITHM: the FIELD is named per collection via
// `sort_field`, and nothing here may assume what it is called.
//
// ⚠ THE ALPHABET IS LOAD-BEARING. `compareValues` (temporal.js) ends in `localeCompare`, which is
// locale-aware, so the library's DEFAULT base-62 keys mis-sort here: prepending three times gives
// `Zy Zz a0`, and `sortRows` returns `a0 Zy Zz`. Same trap that breaks fractional indexing on
// Postgres under `en_US.utf8` instead of `C`. a-z is the intersection where three things hold at
// once — locale order agrees with codepoint order, and no key can parse as a number (the numeric
// branch of `compareValues` would sort "9" after "10") or as a temporal.
//
// test/unit/fractional-index.test.js asserts the base-62 failure directly, so this argument cannot
// be deleted as noise.
//
// Why a dependency rather than 75 lines of our own: the naive midpoint (halve toward the open end)
// degenerates on APPEND, which is the commonest write — measured at 200-character keys after 1000
// appends. The library's integer-part-with-magnitude-head keeps that at 4.
import { generateKeyBetween } from 'fractional-indexing';

const DIGITS = 'abcdefghijklmnopqrstuvwxyz';

/** A key strictly between `a` and `b`. Either may be null for an open end. */
export const keyBetween = (a, b) => generateKeyBetween(a ?? null, b ?? null, DIGITS);

/**
 * The key that puts `id` where `dest` asks, given the collection's records in current sort order
 * (`[{ id, key }]`, blanks first). PURE — the caller does the reading and the writing, which is what
 * lets the CLI and the HTTP surface share one placement rule instead of two that drift.
 *
 * Fails closed on a destination that is not placed yet: with no key on the target there is nothing to
 * compute against, and guessing would silently put the record somewhere the operator did not ask for.
 */
export function placementKey(rows, id, dest, collection = '<collection>') {
	const placed = rows.filter((r) => r.key && r.id !== id);
	const at = (t) => {
		const i = placed.findIndex((r) => r.id === t);
		if (i < 0) throw new Error(`"${t}" has no sort value yet — run \`dreamteamer ${collection} move --init\` first. nothing was written.`);
		return i;
	};
	if (dest.top) return keyBetween(null, placed[0]?.key ?? null);
	if (dest.bottom) return keyBetween(placed[placed.length - 1]?.key ?? null, null);
	if (typeof dest.after === 'string') { const i = at(dest.after); return keyBetween(placed[i].key, placed[i + 1]?.key ?? null); }
	if (typeof dest.before === 'string') { const i = at(dest.before); return keyBetween(placed[i - 1]?.key ?? null, placed[i].key); }
	throw new Error('say where to put it — --after <id>, --before <id>, --top or --bottom. nothing was written.');
}
