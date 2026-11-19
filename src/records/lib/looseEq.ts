/**
 * exported (through the public API) because a proof runner's enum validation has to compare the way THIS module compares: a proof's
 * `_eq: '5'` against a numeric enum member 5 is one filter at run time, and a strict `includes`
 * there refused a proof that works — worse than the silent pass it was written to prevent.
 */
export const looseEq = (v: unknown, o: unknown): boolean =>
  v === o || String(v) === String(o) || (typeof v === "number" && Number(o) === v)
