import { readFileSync } from "node:fs"
import { join } from "node:path"
import { envContext, renderTemplate } from "../../api/renderTemplate.ts"
import { DtError } from "../../lib/DtError.ts"
import { splitRef } from "../../model/splitRef.ts"
import { get } from "../../store/get.ts"
import type { Verb } from "../Verb.ts"

export const resolve: Verb = {
  usage: "resolve '<text>' | <ref> <field>         render ${env:NAME} from this machine's .env",
  options: [],
  run(a) {
    const target = a.wanted("a text template, or a <collection>/<id> and a field")
    // a reference never holds a template, and text that names no record renders as itself
    const at = target.includes("${") ? null : splitRef(a.model, target, true)
    if (a.extra.length > (at ? 1 : 0))
      throw new DtError(`resolve takes ${at ? "a reference and one field" : "one text"} — not "${a.extra.join(" ")}"`)
    const pkg: unknown = JSON.parse(readFileSync(join(a.model.root, "package.json"), "utf8"))
    const ctx = envContext({ root: a.model.root, pkg })
    if (!at) {
      a.out(renderTemplate(target, ctx))
      return 0
    }
    const field = a.extra[0]
    if (!field) throw new DtError(`resolve ${target} needs a field: resolve ${target} <field>`)
    const data = get(a.model, `${at.collection}/${at.id}`).data
    if (!Object.hasOwn(data, field)) throw new DtError(`${target} has no field "${field}"`)
    const items = [data[field]].flat()
    const text = items.filter((t) => typeof t === "string")
    if (text.length < items.length)
      throw new DtError(`${target} ${field} is not text — resolve renders text or a list of it`)
    // every item is rendered before any is printed: a failure leaves no partial list for a shell loop
    const out = text.map((t) => renderTemplate(t, ctx))
    if (out.length) a.out(out.join("\n"))
    return 0
  },
}
