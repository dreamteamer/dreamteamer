import type { Model } from "../types/Model.ts"
import { filesOf } from "./filesOf.ts"
import { openCollection } from "./openCollection.ts"

/** the ids of a collection's records, sorted; a source kind's are the model's */
export function listIds(model: Model, name: string): string[] {
  const c = openCollection(model, name)
  const src = model.sources[c.name]
  return src ? Object.keys(src).sort() : [...filesOf(model, c).keys()].sort()
}
