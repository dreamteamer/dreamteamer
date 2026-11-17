import type { Model } from "../types/Model.ts"
import type { Relation } from "../types/Relation.ts"

/**
 * The model's reverse fields. One is declared on the reverse side — a field `mirror_of: f` of `type: O` on a
 * collection T — and stands for O's reference field `f`. A reverse field whose owner is not installed is inert.
 */
export function relationsOf(model: Model): Relation[] {
  const res: Relation[] = []
  for (const t of Object.values(model.collections))
    for (const [mirror, m] of Object.entries(t.fields)) {
      if (m.mirror_of === undefined) continue
      const owner = Array.isArray(m.type) ? m.type[0] : m.type
      const f = model.collections[owner]?.fields[m.mirror_of]
      if (!f) continue
      const list = f.many === true
      const r: Relation = {
        owner,
        field: m.mirror_of,
        target: t.name,
        mirror,
        list,
        unique: f.unique === true && !list,
      }
      res.push(r)
    }
  return res
}
