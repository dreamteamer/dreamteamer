import { splitRef } from "../model/splitRef.ts"
import type { DtRecord } from "../types/DtRecord.ts"
import type { Model } from "../types/Model.ts"
import { getSource } from "./getSource.ts"
import { load } from "./load.ts"

/** the record a reference names; a source kind's is read from the model and the modules */
export function get(model: Model, ref: string): DtRecord {
  const at = splitRef(model, ref, true)
  return at && model.sources[at.collection] ? getSource(model, at.collection, at.id) : load(model, ref).rec
}
