import { splitRef } from "../model/splitRef.ts"
import type { Model } from "../types/Model.ts"
import { find } from "./find.ts"

/** a reference names a record that exists, a source the model holds, or an id the exports manifest vouches for */
export function refExists(model: Model, ref: string): boolean {
  const at = splitRef(model, ref)
  if (!at) return false
  if (model.exports[at.collection]?.includes(at.id)) return true
  const src = model.sources[at.collection]
  if (src) return Object.hasOwn(src, at.id)
  const c = model.collections[at.collection]
  try {
    return find(model, c, at.id) !== undefined
  } catch {
    return false
  }
}
