import { compareValues } from "./compareValues.ts"
import type { SchemaProp } from "../record/types.ts"

/** `?sort=field` / `?sort=-field`, ordered with `compareValues`. Mutates and returns `rows`. Given the
 *  collection's `schema`, an enum field sorts by its DECLARED order (draft → active → done), blanks
 *  first and values outside the enum after it. */
export function sortRows<T>(rows: T[], sort: string | null | undefined, schema?: Record<string, unknown>): T[] {
  if (!sort) return rows
  const desc = String(sort).startsWith("-")
  const key = desc ? String(sort).slice(1) : String(sort)
  const prop = (schema as SchemaProp | undefined)?.properties?.[key]
  const order = prop?.enum ?? prop?.items?.enum
  const rank = (v: unknown): number =>
    v == null || v === "" ? -1 : order.includes(v) ? order.indexOf(v) : order.length
  const at = (r: T) => (r as Record<string, unknown>)[key]
  const cmp = Array.isArray(order)
    ? (a: T, b: T) => rank(at(a)) - rank(at(b)) || compareValues(at(a) ?? "", at(b) ?? "")
    : (a: T, b: T) => compareValues(at(a) ?? "", at(b) ?? "")
  return rows.sort((a, b) => cmp(a, b) * (desc ? -1 : 1))
}
