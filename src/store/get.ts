import type { DtRecord } from "../types/DtRecord.ts"
import type { Model } from "../types/Model.ts"
import { load } from "./load.ts"

/** the record a reference names */
export function get(model: Model, ref: string): DtRecord {
  return load(model, ref).rec
}
