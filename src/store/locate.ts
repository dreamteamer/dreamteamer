import { join } from "node:path"
import { DtError } from "../lib/DtError.ts"
import { splitRef } from "../model/splitRef.ts"
import type { Collection } from "../types/Collection.ts"
import type { Model } from "../types/Model.ts"
import { openCollection } from "./openCollection.ts"
import { present } from "./present.ts"
import { readOnly } from "./readOnly.ts"
import { recordPath } from "./recordPath.ts"

/** the collection, id and file of an existing record, to be changed or removed: never a source kind's */
export function locate(model: Model, ref: string) {
  const at = splitRef(model, ref, true)
  if (!at)
    throw new DtError(
      ref ? `${ref}: not a <collection>/<id> reference` : "which record? give a <collection>/<id> reference",
    )
  readOnly(model, at.collection)
  const c = openCollection(model, at.collection)
  const path = recordPath(model, c, at.id)
  if (!present(join(model.root, c.storage.path), path)) throw new DtError(`${c.name}/${at.id}: no such record`)
  const res: { c: Collection; id: string; path: string } = { c, id: at.id, path }
  return res
}
