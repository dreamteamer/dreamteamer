import type { Issue } from "../types/Issue.ts"
import type { Model } from "../types/Model.ts"
import { checkField } from "./checkField.ts"
import { checkValue } from "./checkValue.ts"
import { openCollection } from "./openCollection.ts"

/** everything wrong with a record's id and fields, as issues */
export function validate(
  model: Model,
  collection: string,
  id: string,
  data: Record<string, unknown>,
  unresolved?: Map<string, number>,
): Issue[] {
  const c = openCollection(model, collection)
  const where = `${c.name}/${id}`
  const issues: Issue[] = []
  function err(message: string) {
    issues.push({ severity: "error", where, message })
  }
  if (c.ids.pattern && !new RegExp(c.ids.pattern).test(id)) err(`id does not match ${c.ids.pattern}`)
  for (const [name, f] of Object.entries(c.fields)) if (f.required && data[name] === undefined) err(`${name}: required`)
  for (const [name, v] of Object.entries(data)) {
    if (name === "created" && !c.fields.created) {
      if (v != null && checkValue(model, { type: "datetime" }, v)) err("created: expected a date and time with a zone")
      continue
    }
    const f = c.fields[name]
    if (!f) {
      err(`${name}: unknown field — the fields are ${Object.keys(c.fields).join(", ")}`)
      continue
    }
    for (const m of checkField(model, f, v, name, unresolved)) err(m)
  }
  return issues
}
