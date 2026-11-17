import { join } from "node:path"
import { splitRef } from "../model/splitRef.ts"
import type { Collection } from "../types/Collection.ts"
import type { Model } from "../types/Model.ts"
import { checkId } from "./checkId.ts"
import { recordPath } from "./recordPath.ts"

/** the owner a record of a collection stored under its owners names, when its owner field holds one */
export function ownerOf(model: Model, c: Collection, data: Record<string, unknown>): string | undefined {
  const v = c.under && data[c.under.parent]
  const at = typeof v === "string" && splitRef(model, v)
  return at && at.collection === c.under?.collection ? at.id : undefined
}

/** the file a record with these fields belongs at: inside its owner's folder when it is stored there, else its own */
export function pathFor(model: Model, c: Collection, id: string, data: Record<string, unknown>): string {
  const owner = ownerOf(model, c, data)
  if (owner) checkId(owner)
  const p = c.under && model.collections[c.under.collection]
  return recordPath(
    model,
    c,
    id,
    p && owner ? join(model.root, p.storage.path, owner, c.under?.subfolder ?? "") : undefined,
  )
}
