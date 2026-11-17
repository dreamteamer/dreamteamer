import { get as record } from "../../store/get.ts"
import type { Verb } from "../Verb.ts"

export const get: Verb = {
  usage: "get <ref> [--json]",
  options: ["json"],
  run(a) {
    a.noExtra()
    const r = record(a.model, a.wanted("a <collection>/<id> reference"))
    a.out(a.opts.json ? r : r.data)
    return 0
  },
}
