import { DtError } from "../../lib/DtError.ts"
import { rebuild } from "../../store/rebuild.ts"
import type { Verb } from "../Verb.ts"

export const relations: Verb = {
  usage: "relations rebuild <collection>           recompute its reverse fields from their owners",
  options: [],
  run(a) {
    if (a.target !== "rebuild") throw new DtError("relations takes rebuild <collection>")
    if (!a.extra[0]) throw new DtError("relations rebuild needs a collection")
    a.noExtra(1)
    const refs = rebuild(a.model, a.collectionOf(a.extra[0]).name)
    refs.forEach((t) => a.out(`✔ ${t}`))
    a.out(`${refs.length} record(s) rewritten`)
    return 0
  },
}
