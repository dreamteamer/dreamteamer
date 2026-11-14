import { parseTemporal } from "./parseTemporal.ts"

/**
 * The ordering used by every range filter and every `?sort=`. Temporals first (as instants),
 * then numbers numerically, then locale string order.
 *
 * The numeric branch deliberately excludes `''`: `Number('')` is 0, which would sort a blank field
 * as "zero" and slot it between real numbers instead of grouping the blanks together.
 */
export function compareValues(a: unknown, b: unknown): number {
  const ta = parseTemporal(a)
  const tb = parseTemporal(b)
  if (ta !== null && tb !== null) return ta - tb

  if (a !== "" && b !== "" && a != null && b != null) {
    const na = Number(a)
    const nb = Number(b)
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
  }
  return String(a ?? "").localeCompare(String(b ?? ""))
}
