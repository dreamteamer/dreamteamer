import { DtError } from "../../lib/DtError.ts"
import { add as addRecord } from "../../store/add.ts"
import { fieldValues } from "../fieldValues.ts"
import type { Verb } from "../Verb.ts"

export const add: Verb = {
  usage: 'add <collection> ["<title>"] --<field> <value>… [--id <id>]',
  options: ["id"],
  fields: true,
  run(a) {
    const c = a.collectionOf(a.wanted("a collection"))
    a.noExtra(1)
    // one bare argument is the record's title: its `name`, else its `title`, else its first required text field
    const required = Object.keys(c.fields).filter((t) => c.fields[t].required && c.fields[t].type === "string")
    const title = ["name", "title", ...required].find((t) => c.fields[t])
    if (a.extra.length && !title)
      throw new DtError(`${c.name} has no title field to put "${a.extra[0]}" in — name the field`)
    const named: [string, string | undefined][] = title !== undefined && a.extra.length ? [[title, a.extra[0]]] : []
    a.done(addRecord(a.model, c.name, fieldValues(c, [...named, ...a.fields]), a.opts.id?.[0]))
    return 0
  },
}
