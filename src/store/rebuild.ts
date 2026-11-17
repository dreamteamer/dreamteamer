import { relationsOf } from "../model/relationsOf.ts"
import type { Model } from "../types/Model.ts"
import { expectedMirrors, sameMirror } from "./expectedMirrors.ts"
import { get } from "./get.ts"
import { listIds } from "./listIds.ts"
import { openCollection } from "./openCollection.ts"
import { rewrite } from "./rewrite.ts"

/** the fields of every record of a collection, by id */
export function recordsOf(model: Model, collection: string) {
  return new Map(listIds(model, collection).map((t) => [t, get(model, `${collection}/${t}`).data]))
}

/** Recompute a collection's reverse fields from their owners and rewrite the records that disagree; returns their refs. */
export function rebuild(model: Model, collection: string): string[] {
  const c = openCollection(model, collection)
  const targets = recordsOf(model, c.name)
  const changed = new Set<string>()
  for (const r of relationsOf(model)) {
    if (r.target !== c.name) continue
    const exp = expectedMirrors(r, recordsOf(model, r.owner))
    for (const [id, data] of targets)
      if (!sameMirror(r, data[r.mirror], exp.get(id))) {
        rewrite(model, `${c.name}/${id}`, [[r.mirror, exp.get(id)]], false)
        data[r.mirror] = exp.get(id)
        changed.add(`${c.name}/${id}`)
      }
  }
  return [...changed].sort()
}
