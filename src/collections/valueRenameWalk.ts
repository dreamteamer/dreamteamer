import { recordRewrites } from "./recordRewrites.ts"
import { renameValueInCondition } from "./renameValueInCondition.ts"
import { renameValueInConstraint } from "./renameValueInConstraint.ts"
import { FILTER_KEYS, renameKey, viewCollection } from "./schema-ops.ts"
import type { SourceVisitor, Tree, Walk } from "./types.ts"
import { walkFilter } from "./walkFilter.ts"
import { walkSources } from "./walkSources.ts"
import type { Store } from "../record/Store.ts"
import { fieldsOf } from "../record/descriptor.ts"
import type { Field, Workspace } from "../types.ts"

export function valueRenameWalk(
  ws: Workspace,
  store: Store,
  collection: string,
  field: string,
  from: string,
  to: string
): Walk {
  const fieldsOfColl = (c: string): Record<string, Field> =>
    store.descriptors.has(c) ? fieldsOf(store.descriptor(c)) : {}
  const visit: SourceVisitor = {
    own: (doc, at) => {
      const f = doc.fields?.[field]
      if (f && typeof f === "object") {
        if (Array.isArray(f.enum) && f.enum.includes(from)) {
          f.enum = f.enum.map(v => (v === from ? to : v))
          at(`fields.${field}.enum`)
        } else if (f.enum && typeof f.enum === "object" && from in f.enum) {
          f.enum = renameKey(f.enum as Tree, from, to) as Field["enum"]
          at(`fields.${field}.enum`, undefined, to, ["fields", field, "enum", from])
        }
        if (f.default === from) {
          f.default = to
          at(`fields.${field}.default`)
        } else if (Array.isArray(f.default) && f.default.includes(from)) {
          f.default = f.default.map(v => (v === from ? to : v))
          at(`fields.${field}.default`)
        }
      }
      ;(Array.isArray(doc.constraints) ? doc.constraints : []).forEach((c, i) =>
        renameValueInConstraint(c, field, from, to, at, `constraints[${i}]`)
      )
    },
    view: (doc, kind, at) => {
      for (const key of FILTER_KEYS[kind]) {
        walkFilter(
          doc[key],
          viewCollection(doc),
          fieldsOfColl,
          {
            field: (node, k, coll, note, label) => {
              if (coll === collection && k === field) renameValueInCondition(node, k, from, to, note, label)
            },
            union: (cond, targets, note, label) => {
              if (targets.includes(collection) && field in cond)
                note(
                  `${label}.${field}`,
                  `a filter hop through a union (${targets.join(", ")}) cannot say which member's "${field}" it means — rewrite it by hand`
                )
            },
          },
          at,
          key
        )
      }
    },
  }
  const { positions, edits } = walkSources(ws, store, collection, visit)
  const records = recordRewrites(store, collection, fields => {
    const v = fields[field]
    if (v === from) return { ...fields, [field]: to }
    if (Array.isArray(v) && v.includes(from)) return { ...fields, [field]: v.map(x => (x === from ? to : x)) }
    return null
  })
  return { positions, edits, records }
}
