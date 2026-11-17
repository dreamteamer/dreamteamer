import { join } from "node:path"
import type { Collection } from "../types/Collection.ts"
import type { Model } from "../types/Model.ts"
import type { Root } from "../types/Root.ts"

/** the folders a collection's records are read from, in the order an id is looked up: its own first */
export function rootsOf(model: Model, c: Collection): Root[] {
  const res: Root[] = [{ dir: join(model.root, c.storage.path) }]
  return res
}
