import { DtError } from "../../lib/DtError.ts"
import { findCollection } from "../../model/findCollection.ts"
import { splitRef } from "../../model/splitRef.ts"
import { commandsFor } from "../../store/commandsFor.ts"
import type { Verb } from "../Verb.ts"

export const next: Verb = {
  usage: "next <collection>[/<id>] [--ids <id>,…] [--json]   which bound commands apply, and in which state",
  options: ["ids", "json"],
  run(a) {
    a.noExtra()
    const target = a.wanted("a collection or a <collection>/<id> reference")
    const at = findCollection(a.model, target) ? { collection: target, id: "" } : splitRef(a.model, target, true)
    if (!at) throw new DtError(`unknown collection or reference ${target}`)
    const given = a.opts.ids ? a.opts.ids.flatMap((t) => t.split(",")) : [at.id]
    const ids = given.map((t) => t.trim()).filter(Boolean)
    const out = commandsFor(a.model, at.collection, ids)
    if (a.opts.json) a.out(Object.assign({}, out, { notes: [] }))
    else if (!out.commands.length) a.out(`(no commands bound to ${out.collection})`)
    else
      for (const c of out.commands) {
        if (c.scope === "collection") {
          a.out(`${String(c.name)}  [collection]  ${String(c.invocation)}`)
          continue
        }
        const [ok, done] = [c.eligible, c.done].map((t) => (Array.isArray(t) ? t.length : 0))
        const counts = ids.length ? `  ${ok}/${ids.length} eligible${done ? `, ${done} done` : ""}` : "  (no ids given)"
        a.out(`${String(c.name)}  [record]${counts}${typeof c.invocation === "string" ? `\n  ${c.invocation}` : ""}`)
      }
    return 0
  },
}
