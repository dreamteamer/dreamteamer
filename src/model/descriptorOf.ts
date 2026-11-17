import { isObject } from "../lib/isObject.ts"
import { kept } from "../lib/kept.ts"
import { titleOf } from "../lib/titleOf.ts"
import type { Model } from "../types/Model.ts"
import { moduleId } from "./moduleId.ts"
import { SCALARS } from "./SCALARS.ts"

/** the fields every record has, which the released engine adds in front of a collection's own, in its words */
const INJECTED = {
  id: { type: "string", title: "Id", virtual: true, description: "The record's path inside its collection." },
  created: {
    type: "datetime",
    title: "Created",
    derived: true,
    description:
      "When the record was first written. Stamped by the engine at add; read from the id's date or the first commit for a record written before it existed.",
  },
  last_modified: {
    type: "datetime",
    title: "Last modified",
    virtual: true,
    description: "When the record was last committed, from git.",
  },
}

/**
 * A collection as the released engine compiles it, with only the keys its readers use: the keys as written (storage
 * and ids resolved), and a `compiled` block with `defaults` (the title, record title and layouts nobody wrote),
 * `module`, `repo`, `runtime` (true for a source kind, whose records sit under `.dreamteamer/`), `overlaid_by` and
 * `fields` — every field, the three every record has first, each with a title. No `json_schema`, `mirrors`, `layers`
 * or `under_collection`: nothing here validates through them.
 */
export function descriptorOf(model: Model, name: string): Record<string, unknown> {
  const c = model.collections[name]
  const display = c.display ?? {}
  const layout = (b: string) =>
    isObject(display[b]) && display[b].layout !== undefined ? undefined : { layout: b === "list" ? "table" : "page" }
  const probe = ["title", "name", "subject"].find((t) => c.fields[t])
  const fields: Record<string, unknown> = Object.assign({}, INJECTED)
  // each field with the title and, for a reference that does not say, the `on_delete: restrict` compile supplies
  for (const [n, f] of Object.entries(c.fields)) {
    const ref = typeof f.type !== "string" || !SCALARS.has(f.type) || f.type === "reference"
    const restrict = ref && f.on_delete === undefined && f.mirror_of === undefined ? { on_delete: "restrict" } : {}
    fields[n] = Object.assign({}, f, { title: f.title ?? titleOf(n) }, restrict)
  }
  return kept({
    name: c.name,
    title: c.title,
    singular: c.singular,
    record_title: c.record_title,
    description: c.description,
    use_when: c.use_when,
    internal: c.internal,
    sensitive: c.sensitive,
    storage: kept(c.storage),
    ids: kept(c.ids),
    fields: c.fields,
    constraints: c.constraints,
    display: c.display,
    compiled: {
      defaults: kept({
        title: c.title === undefined ? titleOf(name.slice(name.lastIndexOf("/") + 1)) : undefined,
        record_title: c.record_title === undefined ? `{{ ${probe ?? "id"} }}` : undefined,
        display: kept({ list: layout("list"), record: layout("record") }),
      }),
      module: moduleId(c.module),
      repo: ".",
      runtime: Boolean(model.sources[name]),
      overlaid_by: c.contributors.map(moduleId).filter((t) => t !== moduleId(c.module)),
      fields,
    },
  })
}
