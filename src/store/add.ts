import { existsSync } from "node:fs"
import { DtError } from "../lib/DtError.ts"
import { stamp } from "../lib/stamp.ts"
import { bodyField } from "../model/bodyField.ts"
import { yamlOf } from "../yaml/yamlOf.ts"
import type { DtRecord } from "../types/DtRecord.ts"
import type { Model } from "../types/Model.ts"
import { compose } from "./compose.ts"
import { find } from "./find.ts"
import { get } from "./get.ts"
import { makeId } from "./makeId.ts"
import { openCollection } from "./openCollection.ts"
import { readOnly } from "./readOnly.ts"
import { recordPath } from "./recordPath.ts"
import { refuseTaken } from "./refuseTaken.ts"
import { write } from "./write.ts"
import { applyMirrors, mirrorEdits, refuseMirrors } from "./mirrorEdits.ts"

/** Write a new record: the given fields, `created`, then the defaults. Refuses to replace one that exists. */
export function add(model: Model, collection: string, input: Record<string, unknown>, id?: string): DtRecord {
  const c = openCollection(model, collection)
  readOnly(model, c.name)
  const bf = bodyField(c)
  const warnings: string[] = []
  const data: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input))
    if (v !== undefined && v !== null) data[k] = c.fields[k]?.many && !Array.isArray(v) ? [v] : v
  data.created ??= stamp()
  for (const [name, f] of Object.entries(c.fields))
    if (f.default !== undefined && data[name] === undefined) data[name] = f.default
  const newId = id ?? makeId(c, data, warnings)
  const path = recordPath(model, c, newId)
  // the exact spelling of an id, or one that differs only in case where the file system ignores case
  if (existsSync(path) || find(model, c, newId))
    throw new DtError(`${c.name}/${newId} already exists — nothing written`)
  refuseMirrors(model, c.name, newId, Object.keys(input))
  refuseTaken(model, c, newId, data, Object.keys(data))
  const mirrors = mirrorEdits(model, c.name, newId, null, data)
  const text = bf ? data[bf] : undefined
  let body = typeof text === "string" ? text : ""
  if (body && !body.endsWith("\n")) body += "\n"
  const front = Object.fromEntries(Object.entries(data).filter(([k]) => !(c.storage.format === "md" && k === bf)))
  write(model, c, newId, path, data, compose(c, yamlOf(front), data, body), undefined)
  applyMirrors(model, mirrors)
  const rec = get(model, `${c.name}/${newId}`)
  if (warnings.length) rec.warnings = warnings
  return rec
}
