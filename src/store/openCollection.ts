import { DtError } from "../lib/DtError.ts"
import { findCollection } from "../model/findCollection.ts"
import type { Model } from "../types/Model.ts"

/** the collection a command names, if its records can be read and written here */
export function openCollection(model: Model, name: string) {
  const c = name ? findCollection(model, name) : undefined
  if (!c) {
    const all = Object.keys(model.collections).sort().join(", ")
    throw new DtError(name ? `unknown collection ${name} — the collections are ${all}` : "which collection? name one")
  }
  return c
}
