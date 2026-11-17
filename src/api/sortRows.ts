import { mapOf } from "../lib/mapOf.ts"
import { compareValues } from "./compareValues.ts"

/**
 * Sort rows in place by `field` or `-field` (descending), with `compareValues`; given the collection's JSON Schema, an
 * enum field sorts in its declared order, blanks first and values outside the enum after it. Returns the rows.
 */
export function sortRows<T extends Record<string, unknown>>(rows: T[], sort: unknown, schema?: unknown): T[] {
  if (!sort || typeof sort !== "string") return rows
  const desc = sort.startsWith("-")
  const key = desc ? sort.slice(1) : sort
  const prop = mapOf(mapOf(mapOf(schema).properties)[key])
  const order = prop.enum ?? mapOf(prop.items).enum
  function rank(v: unknown) {
    if (!Array.isArray(order)) return 0
    return v === null || v === undefined || v === "" ? -1 : order.includes(v) ? order.indexOf(v) : order.length
  }
  return rows.sort(
    (x, y) => (rank(x[key]) - rank(y[key]) || compareValues(x[key] ?? "", y[key] ?? "")) * (desc ? -1 : 1),
  )
}
