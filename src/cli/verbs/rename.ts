import { Store } from "../../api/Store.ts"
import { DtError } from "../../lib/DtError.ts"
import { splitRef } from "../../model/splitRef.ts"
import type { Verb } from "../Verb.ts"

export const rename: Verb = {
  usage: "rename <ref> <new-id> [--json]           move a record, and rewrite every record that names it",
  options: ["json"],
  run(a) {
    a.noExtra(1)
    const ref = a.wanted("a <collection>/<id> reference and the new id")
    const at = splitRef(a.model, ref, true)
    if (!at) throw new DtError(`${ref}: not a <collection>/<id> reference`)
    const to = a.extra[0]
    if (!to) throw new DtError(`rename needs the new id: rename ${ref} <new-id>`)
    const r = new Store({ root: a.model.root }).rename(at.collection, at.id, to)
    if (a.opts.json) a.out(r)
    else a.out(`✔ renamed ${at.collection}/${at.id} → ${at.collection}/${r.id}`)
    if (!a.opts.json && r.rewrites) a.out(`✔ rewrote the references in ${r.rewrites} file(s)`)
    return 0
  },
}
