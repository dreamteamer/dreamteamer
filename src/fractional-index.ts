import { generateKeyBetween } from "fractional-indexing"

const DIGITS = "abcdefghijklmnopqrstuvwxyz"

/** A key strictly between `a` and `b`. Either may be null for an open end. */
export const keyBetween = (a: string | null, b: string | null): string =>
  generateKeyBetween(a ?? null, b ?? null, DIGITS)

/**
 * The key that puts `id` where `dest` asks, given the collection's records in current sort order
 * (`[{ id, key }]`, blanks first). PURE — the caller does the reading and the writing, which is what
 * lets the CLI and the HTTP surface share one placement rule instead of two that drift.
 *
 * Fails closed on a destination that is not placed yet: with no key on the target there is nothing to
 * compute against, and guessing would silently put the record somewhere the operator did not ask for.
 */
export function placementKey(
  rows: { id: string; key: string }[],
  id: string,
  dest: Record<string, unknown>,
  collection = "<collection>"
): string {
  const placed = rows.filter(r => r.key && r.id !== id)
  const at = (t: string): number => {
    const i = placed.findIndex(r => r.id === t)
    if (i < 0)
      throw new Error(
        `"${t}" has no sort value yet — run \`dreamteamer reorder ${collection} --init\` first. nothing was written.`
      )
    return i
  }
  if (dest.top) return keyBetween(null, placed[0]?.key ?? null)
  if (dest.bottom) return keyBetween(placed[placed.length - 1]?.key ?? null, null)
  if (typeof dest.after === "string") {
    const i = at(dest.after)
    return keyBetween(placed[i].key, placed[i + 1]?.key ?? null)
  }
  if (typeof dest.before === "string") {
    const i = at(dest.before)
    return keyBetween(placed[i - 1]?.key ?? null, placed[i].key)
  }
  throw new Error("say where to put it — --after <id>, --before <id>, --top or --bottom. nothing was written.")
}
