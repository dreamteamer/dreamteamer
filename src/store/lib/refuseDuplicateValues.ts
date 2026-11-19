import type { Descriptor, Fields } from "../../types.ts"
import type { Store } from "../Store.ts"

export function refuseDuplicateValues(
  store: Store,
  d: Descriptor,
  collection: string,
  id: string,
  fields: Fields,
  keys: string[]
) {
  const unique = Object.entries(d.compiled?.fields ?? {}).filter(([k, f]) => f.unique && !f.many && keys.includes(k))
  if (!unique.length) return
  for (const { id: other, fields: of } of store.readAll(collection)) {
    if (other === id) continue
    for (const [k] of unique) {
      const v = fields[k]
      if (v === undefined || v === null || v === "") continue
      if (of[k] === v)
        throw new Error(`${k}: "${v}" is already taken by ${collection}/${other} (unique) — nothing was written.`)
    }
  }
}
