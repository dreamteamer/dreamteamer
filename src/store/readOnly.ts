import { DtError } from "../lib/DtError.ts"
import type { Model } from "../types/Model.ts"

/** refuse a write to a source kind, whose records are the files modules ship, or to a binary record */
export function readOnly(model: Model, collection: string) {
  if (model.collections[collection]?.storage.format === "binary")
    throw new DtError(`${collection}: binary records are read-only in this engine — add or change the file itself`)
  if (model.sources[collection])
    throw new DtError(
      `${collection} are read-only here: each is a file a module ships — change it in the module's ${collection}/ folder`,
    )
}
