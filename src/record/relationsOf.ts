import { fieldsOf, targetsOf } from "./descriptor.ts"
import type { Relation } from "./types.ts"
import type { Descriptors } from "../types.ts"

export function relationsOf(descriptors: Descriptors): Relation[] {
  const out: Relation[] = []
  // A relation is declared once, on the MIRROR: a field `mirror_of: f` with `type: O` on collection T
  // is the generated far side of O's reference `f`. The row is keyed by the owner, as every reader
  // (the store's maintenance, check's expectations, `dt relations`) has always asked it.
  for (const [target, d] of descriptors) {
    for (const [mirror, m] of Object.entries(fieldsOf(d))) {
      if (m.mirror_of === undefined) continue
      const owner = targetsOf(m)?.[0]
      const od = owner && descriptors.get(owner)
      if (!od) continue // an uninstalled peer: the mirror is inert
      const f = fieldsOf(od)[m.mirror_of]
      if (!f) continue // compile refuses this; defensive at runtime
      const list = f.many === true
      const unique = f.unique === true && !list
      out.push({
        owner,
        field: m.mirror_of,
        target,
        mirror,
        list,
        unique,
        onDelete: f.on_delete ?? "restrict",
        kind: list ? "m2m" : unique ? "o2o" : "m2o",
      })
    }
  }
  return out
}
