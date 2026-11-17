import { DtError } from "../lib/DtError.ts"
import { textOf } from "../lib/compareValues.ts"
import { accessors } from "./accessors.ts"
import type { Store } from "./Store.ts"

/**
 * The values a field holds across a collection, most used first: an enum's declared values (no counts), else the
 * records' — each entry of a list counted on its own, a body or an object skipped.
 */
export function distinctValues(store: Store, collection: string, field: string, opts: { limit?: number } = {}) {
  const limit = opts.limit ?? 50
  const d = store.descriptor(collection)
  const all = accessors.fieldsOf(d)
  const f = Object.hasOwn(all, field) ? all[field] : undefined
  if (!f && field !== "id")
    throw new DtError(`unknown field "${field}" on ${collection} (known: ${Object.keys(all).join(", ")})`)
  const counts = new Map<unknown, number | null>()
  const skipped = f?.body ? "body" : f?.type === "object" || f?.type === "map" ? "object" : undefined
  const declared = f?.enum === undefined ? null : accessors.enumValues(f.enum)
  if (!skipped && declared?.length) for (const v of declared) counts.set(v, null)
  else if (!skipped)
    for (const { id, fields } of store.readAll(collection))
      for (const v of [field === "id" ? id : fields[field]].flat())
        if (v !== null && v !== undefined && v !== "" && typeof v !== "object") counts.set(v, (counts.get(v) ?? 0) + 1)
  const sorted = [...counts]
    .sort((x, y) => (y[1] ?? 0) - (x[1] ?? 0) || (declared?.length ? 0 : textOf(x[0]).localeCompare(textOf(y[0]))))
    .map(([value, count]) => ({ value, count }))
  const values = declared?.length ? sorted : sorted.slice(0, limit)
  const res: Record<string, unknown> = {
    collection,
    field,
    values,
    total: sorted.length,
    truncated: values.length < sorted.length,
  }
  if (skipped) res.skipped = skipped
  else res.source = declared?.length ? "enum" : "data"
  return res
}
