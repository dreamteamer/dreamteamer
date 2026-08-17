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
