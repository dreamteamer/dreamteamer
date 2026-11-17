import { DtError } from "../lib/DtError.ts"

/** a position key's digits: a to z, where text order, locale order and code point order agree */
const DIGITS = "abcdefghijklmnopqrstuvwxyz"

/** a key strictly between `lo` and `hi` (`""` and null are the open ends); it never ends in the lowest digit */
function midpoint(lo: string, hi: string | null): string {
  if (hi !== null) {
    let n = 0
    while ((lo[n] ?? "a") === hi[n]) n++
    if (n > 0) return hi.slice(0, n) + midpoint(lo.slice(n), hi.slice(n))
  }
  const a = lo ? DIGITS.indexOf(lo[0]) : 0
  const b = hi !== null ? DIGITS.indexOf(hi[0]) : DIGITS.length
  if (b - a > 1) return DIGITS[Math.round((a + b) / 2)]
  if (hi !== null && hi.length > 1) return hi[0]
  return DIGITS[a] + midpoint(lo.slice(1), null)
}

/**
 * The key that puts `id` where `dest` asks (`top`, `bottom`, `after` or `before` an id), given the records in their
 * current order (`[{ id, key }]`). Review: the released engine takes its keys from the fractional-indexing package
 * over the same digits; this midpoint orders with them, but its keys grow faster on repeated appends.
 */
export function placementKey(
  rows: { id: string; key: unknown }[],
  id: string,
  dest: Record<string, unknown>,
  collection = "<collection>",
) {
  const placed = rows.flatMap((t) =>
    typeof t.key === "string" && t.key && t.id !== id ? [{ id: t.id, key: t.key }] : [],
  )
  function at(t: string) {
    const i = placed.findIndex((r) => r.id === t)
    if (i < 0) throw new DtError(`"${t}" has no sort value yet in ${collection} — nothing was written`)
    return i
  }
  if (dest.top) return midpoint("", placed[0]?.key ?? null)
  if (dest.bottom) return midpoint(placed.at(-1)?.key ?? "", null)
  if (typeof dest.after === "string") {
    const i = at(dest.after)
    return midpoint(placed[i].key, placed[i + 1]?.key ?? null)
  }
  if (typeof dest.before === "string") {
    const i = at(dest.before)
    return midpoint(placed[i - 1]?.key ?? "", placed[i].key)
  }
  throw new DtError("say where to put it — after <id>, before <id>, top or bottom — nothing was written")
}
