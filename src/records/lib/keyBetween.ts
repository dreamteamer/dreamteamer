import { generateKeyBetween } from "fractional-indexing"

const DIGITS = "abcdefghijklmnopqrstuvwxyz"

/** A key strictly between `a` and `b`. Either may be null for an open end. */
export const keyBetween = (a: string | null, b: string | null): string =>
  generateKeyBetween(a ?? null, b ?? null, DIGITS)
