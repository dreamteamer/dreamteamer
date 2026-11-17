import { history as log } from "../../api/history.ts"
import { Store } from "../../api/Store.ts"
import { DtError } from "../../lib/DtError.ts"
import { splitRef } from "../../model/splitRef.ts"
import type { Verb } from "../Verb.ts"

export const history: Verb = {
  usage: "history <ref> [--json]                   the commits that changed a record, newest first",
  options: ["json"],
  run(a) {
    a.noExtra()
    const ref = a.wanted("a <collection>/<id> reference")
    const at = splitRef(a.model, ref, true)
    if (!at) throw new DtError(`${ref}: not a <collection>/<id> reference`)
    const rows = log(new Store({ root: a.model.root }), at.collection, at.id)
    if (a.opts.json) a.out(rows)
    else if (!rows.length) a.out(`(no history for ${at.collection}/${at.id} — not committed yet)`)
    else for (const t of rows) a.out(`${t.hash.slice(0, 7)}  ${t.date.slice(0, 10)}  ${t.author}  ${t.subject}`)
    return 0
  },
}
