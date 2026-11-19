import { asTree } from "../../lib/schema-ops.ts"
import type { At, FilterVisitor } from "./types.ts"
import { targetsOf } from "../../record/descriptor.ts"
import type { Field } from "../../types.ts"

export function walkFilter(
  n: unknown,
  coll: string,
  fieldsOfColl: (c: string) => Record<string, Field>,
  visit: FilterVisitor,
  at: At,
  label: string
): void {
  const node = asTree(n)
  if (!node) return
  for (const key of Object.keys(node)) {
    if (key === "_and" || key === "_or") {
      const subs = node[key]
      ;(Array.isArray(subs) ? subs : []).forEach((c: unknown, i: number) =>
        walkFilter(c, coll, fieldsOfColl, visit, at, `${label}.${key}[${i}]`)
      )
      continue
    }
    if (key.startsWith("_")) continue
    const cond = asTree(node[key])
    if (cond && Object.keys(cond).some(k => !k.startsWith("_"))) {
      const t = targetsOf(fieldsOfColl(coll)?.[key])
      if (Array.isArray(t) && t.length === 1) walkFilter(cond, t[0], fieldsOfColl, visit, at, `${label}.${key}`)
      else if (Array.isArray(t)) visit.union?.(cond, t, at, `${label}.${key}`)
    }
    visit.field(node, key, coll, at, label)
  }
}
