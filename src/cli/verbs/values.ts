import { distinctValues } from "../../api/distinctValues.ts"
import { Store } from "../../api/Store.ts"
import { DtError } from "../../lib/DtError.ts"
import type { Verb } from "../Verb.ts"

export const values: Verb = {
  usage: "values <collection> <field> [--limit <n>] [--json]   the values a field holds, most used first",
  options: ["json", "limit"],
  run(a) {
    a.noExtra(1)
    const c = a.collectionOf(a.wanted("a collection and a field"))
    const field = a.extra[0]
    if (!field) throw new DtError(`values needs a field: values ${c.name} <field>`)
    const limit = a.opts.limit?.at(-1)
    if (limit !== undefined && !Number.isFinite(Number(limit)))
      throw new DtError(`--limit needs a number: values ${c.name} ${field} --limit 20`)
    const r = distinctValues(new Store({ root: a.model.root }), c.name, field, {
      limit: limit === undefined ? undefined : Number(limit),
    })
    if (a.opts.json) a.out(r)
    else if (r.skipped) a.out(`(${c.name}.${field} is a ${r.skipped} field — no value vocabulary)`)
    else if (!r.values.length) a.out(`(no values set on ${c.name}.${field})`)
    else {
      for (const t of r.values)
        a.out(t.count === null ? String(t.value) : `${String(t.count).padStart(5)}  ${String(t.value)}`)
      a.out(`— ${r.total} distinct${r.truncated ? ` (showing ${r.values.length})` : ""}, from ${r.source}`)
    }
    return 0
  },
}
