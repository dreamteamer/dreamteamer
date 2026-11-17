import { commitPending } from "../../api/commitPending.ts"
import { Store } from "../../api/Store.ts"
import { changesOf, printChanges } from "../printChanges.ts"
import type { Verb } from "../Verb.ts"

export const changes: Verb = {
  usage: "changes [--json]                         the records written and not committed",
  options: ["json"],
  run(a) {
    a.none()
    const rows = changesOf(commitPending(new Store({ root: a.model.root }), { dryRun: true }))
    if (a.opts.json) a.out({ since: "HEAD", head: "HEAD", events: rows })
    else if (!rows.length) a.out("✔ no record changes since HEAD")
    else {
      printChanges(a.out, rows)
      a.out(`${rows.length} record change(s) since HEAD — ${rows.length} uncommitted`)
    }
    return 0
  },
}
