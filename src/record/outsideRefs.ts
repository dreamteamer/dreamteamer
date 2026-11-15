import { collectRefFields } from "./collectRefFields.ts"
import { fieldsOf } from "./descriptor.ts"
import { valuesAt } from "./valuesAt.ts"
import { parseRef } from "./parseRef.ts"
import type { ExportEntry, OutsideRef } from "./types.ts"
import type { Descriptor, Fields } from "../types.ts"

/**
 * A repo's outside references: every value of a hard, non-mirror reference field on one of its records
 * that names an id the repo does not hold. `records` yields `{ collection, id, fields, descriptor }`;
 * `held(coll, id)` says the repo holds it; `resolve(coll, id)` answers `{ label, from }` or null.
 * @returns {Map<string, { collection, id, resolved, referrers: string[] }>} keyed `<collection>/<id>`
 */
export function outsideRefs({
  records,
  held,
  resolve,
  namespaces,
}: {
  records: Iterable<{ collection: string; id: string; fields: Fields; descriptor: Descriptor }>
  held: (coll: string, id: string) => boolean
  resolve: (coll: string, id: string) => ExportEntry | null
  namespaces: string[]
}): Map<string, OutsideRef> {
  const out = new Map<string, OutsideRef>()
  for (const { collection, id, fields, descriptor } of records) {
    for (const [fieldPath, targets, soft] of collectRefFields(fieldsOf(descriptor))) {
      if (soft || (fieldPath.length === 1 && fieldsOf(descriptor)[fieldPath[0]]?.mirror_of !== undefined)) continue
      for (const value of valuesAt(fields, fieldPath)) {
        const ref = typeof value === "string" && !value.startsWith("@") ? parseRef(value, namespaces) : null
        if (!ref || (targets !== "*" && !targets.includes(ref.collection)) || held(ref.collection, ref.id)) continue
        const key = `${ref.collection}/${ref.id}`
        if (!out.has(key))
          out.set(key, {
            collection: ref.collection,
            id: ref.id,
            resolved: resolve(ref.collection, ref.id),
            referrers: [],
          })
        out.get(key).referrers.push(`${collection}/${id}`)
      }
    }
  }
  return out
}
