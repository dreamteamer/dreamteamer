import { commitPending } from "../../api/commitPending.ts"
import { Store } from "../../api/Store.ts"
import { DtError } from "../../lib/DtError.ts"
import { changesOf, printChanges } from "../printChanges.ts"
import type { Verb } from "../Verb.ts"

export const commit: Verb = {
  usage: "commit [<ref>|<collection>]… [-m <message>] [--dry-run] [--json]   commit those record files",
  options: ["json", "dry-run"],
  run(a) {
    const m = a.pos.indexOf("-m")
    if (m >= 0 && !a.pos[m + 1]) throw new DtError("-m needs a message: commit tasks -m 'Plan the week'")
    const only = a.pos.filter((_, i) => m < 0 || (i !== m && i !== m + 1))
    const dryRun = Boolean(a.opts["dry-run"])
    const done = commitPending(new Store({ root: a.model.root }), {
      only,
      message: m < 0 ? undefined : a.pos[m + 1],
      dryRun,
    })
    if (a.opts.json) a.out(done)
    else if (!done.length) a.out("nothing pending")
    else {
      for (const r of done) a.out(`✔ workspace${r.sha ? ` ${r.sha}` : " (dry run)"} — ${r.subject}`)
      printChanges(a.out, changesOf(done))
    }
    return 0
  },
}
