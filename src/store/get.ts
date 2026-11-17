import { statSync } from "node:fs"
import { extname } from "node:path"
import { DtError } from "../lib/DtError.ts"
import { splitRef } from "../model/splitRef.ts"
import type { DtRecord } from "../types/DtRecord.ts"
import type { Model } from "../types/Model.ts"
import { find } from "./find.ts"
import { getSource } from "./getSource.ts"
import { load } from "./load.ts"

/**
 * the record a reference names; a source kind's is read from the model and the modules, and a binary one's fields from
 * its file, as the released engine derives them: its extension, lowercase, and its size
 */
export function get(model: Model, ref: string): DtRecord {
  const at = splitRef(model, ref, true)
  if (at && model.sources[at.collection]) return getSource(model, at.collection, at.id)
  const c = at && model.collections[at.collection]
  if (!at || c?.storage.format !== "binary") return load(model, ref).rec
  const hit = find(model, c, at.id)
  if (!hit) throw new DtError(`${c.name}/${at.id}: no such record`)
  const { size, mtimeMs } = statSync(hit.path)
  const data = { ext: extname(hit.path).slice(1).toLowerCase(), bytes: size }
  const res: DtRecord = { ref: `${c.name}/${at.id}`, collection: c.name, id: at.id, path: hit.path, data, mtimeMs }
  return res
}
