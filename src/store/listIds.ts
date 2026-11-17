import { join } from "node:path"
import type { Model } from "../types/Model.ts"
import { idsIn } from "./idsIn.ts"
import { openCollection } from "./openCollection.ts"

/** the ids of a collection's records, sorted */
export function listIds(model: Model, name: string): string[] {
  const c = openCollection(model, name)
  return idsIn(join(model.root, c.storage.path), c)
}
