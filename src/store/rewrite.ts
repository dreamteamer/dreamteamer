import { bodyField } from "../model/bodyField.ts"
import type { Model } from "../types/Model.ts"
import { holds } from "../yaml/holds.ts"
import { editYaml } from "../yaml/editYaml.ts"
import { yamlOf } from "../yaml/yamlOf.ts"
import { compose } from "./compose.ts"
import { load } from "./load.ts"
import { write } from "./write.ts"

/**
 * Change fields of a record that are not its body, keeping every other line as written. `undefined` removes a
 * field. Only `checked` writes are validated: a reverse field is written whatever else the record holds.
 */
export function rewrite(model: Model, ref: string, changes: [string, unknown][], checked = true) {
  const { rec, c, doc, front, body } = load(model, ref)
  for (const [k, v] of changes)
    if (v === undefined) delete rec.data[k]
    else rec.data[k] = v
  const bf = c.storage.format === "md" ? bodyField(c) : undefined
  const fields = Object.fromEntries(Object.entries(rec.data).filter(([k]) => k !== bf))
  // edit the lines that change; if the result would not read back as the fields meant, write the fields afresh
  let yaml = doc ? editYaml(front, doc, changes) : null
  if (doc && (yaml === null || !holds(yaml, fields))) yaml = yamlOf(fields)
  return write(model, c, rec.id, rec.data, compose(c, yaml ?? "", rec.data, body), rec.mtimeMs, checked)
}
