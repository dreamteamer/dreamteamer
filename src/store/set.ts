import { holds } from "../yaml/holds.ts"
import { editYaml } from "../yaml/editYaml.ts"
import { yamlOf } from "../yaml/yamlOf.ts"
import { bodyField } from "../model/bodyField.ts"
import type { DtRecord } from "../types/DtRecord.ts"
import type { Model } from "../types/Model.ts"
import { compose } from "./compose.ts"
import { get } from "./get.ts"
import { load } from "./load.ts"
import { refuseTaken } from "./refuseTaken.ts"
import { write } from "./write.ts"
import { applyMirrors, mirrorEdits, refuseMirrors } from "./mirrorEdits.ts"

/** Change some fields of a record. `null` or an empty string clears a field; a field with a default goes back to it. */
export function set(model: Model, ref: string, changes: Record<string, unknown>): DtRecord {
  const { rec, c, doc, front, body: before } = load(model, ref)
  const bf = c.storage.format === "md" ? bodyField(c) : undefined
  const data = rec.data
  refuseMirrors(model, c.name, rec.id, Object.keys(changes))
  const prior = Object.assign({}, data)
  const edits: [string, unknown][] = []
  let body = before
  for (const [k, raw] of Object.entries(changes)) {
    const cleared = raw === null || raw === ""
    const v = cleared ? c.fields[k]?.default : c.fields[k]?.many && !Array.isArray(raw) ? [raw] : raw
    if (v === undefined) delete data[k]
    else data[k] = v
    if (k === bf) body = typeof v === "string" && v ? (v.endsWith("\n") ? v : v + "\n") : ""
    else edits.push([k, v])
  }
  const fields = Object.fromEntries(Object.entries(data).filter(([k]) => k !== bf))
  // edit the lines that change; if the result would not read back as the fields meant, write the fields afresh
  let yaml = doc ? editYaml(front, doc, edits) : null
  if (doc && (yaml === null || !holds(yaml, fields))) yaml = yamlOf(fields)
  refuseTaken(model, c, rec.id, data, Object.keys(changes))
  const mirrors = mirrorEdits(model, c.name, rec.id, prior, data)
  write(model, c, rec.id, data, compose(c, yaml ?? "", data, body), rec.mtimeMs)
  applyMirrors(model, mirrors)
  return get(model, rec.ref)
}
