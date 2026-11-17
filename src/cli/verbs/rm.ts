import { rm as rmRecord } from "../../store/rm.ts"
import type { Verb } from "../Verb.ts"

export const rm: Verb = {
  usage: "rm <ref> [--force]",
  options: ["force"],
  run(a) {
    a.noExtra()
    a.out(`✔ removed ${rmRecord(a.model, a.wanted("a <collection>/<id> reference"), Boolean(a.opts.force))}`)
    return 0
  },
}
