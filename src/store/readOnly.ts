import { DtError } from "../lib/DtError.ts"
import type { Model } from "../types/Model.ts"

/** refuse a write to a source kind: its records are the files modules ship, and change only there */
export function readOnly(model: Model, collection: string) {
  if (model.sources[collection])
    throw new DtError(
      `${collection} are read-only here: each is a file a module ships — change it in the module's ${collection}/ folder`,
    )
}
