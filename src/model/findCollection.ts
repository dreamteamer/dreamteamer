import type { Collection } from "../types/Collection.ts"
import type { Model } from "../types/Model.ts"

/** the collection a command names: its name, or its singular */
export function findCollection(model: Model, name: string): Collection | undefined {
  return model.collections[name] ?? Object.values(model.collections).find((t) => t.singular === name)
}
