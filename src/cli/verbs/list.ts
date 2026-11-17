import { DtError } from "../../lib/DtError.ts"
import { list as records } from "../../store/list.ts"
import type { Verb } from "../Verb.ts"

export const list: Verb = {
  usage: "list <collection> [--filter <field>=<value>]… [--json]",
  options: ["filter", "json"],
  run(a) {
    a.noExtra()
    const where = Object.fromEntries(
      (a.opts.filter ?? []).map((f) => {
        if (!f.includes("=")) throw new DtError(`--filter takes <field>=<value>, got "${f}"`)
        return [f.slice(0, f.indexOf("=")), f.slice(f.indexOf("=") + 1)]
      }),
    )
    const rows = records(a.model, a.wanted("a collection"), where)
    if (a.opts.json) a.out(rows)
    else rows.forEach((t) => a.out(t.id))
    return 0
  },
}
