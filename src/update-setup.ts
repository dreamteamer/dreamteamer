// The setup half of `dt update`, in a process of its own (rnd/issues …dt-update-runs-the-previous-version-s-setup-unit).
// The process that ran npm imported every extension when it opened the workspace, and ESM caches an
// entry and all it imports by path — so it can only ever run the version being replaced. This file is
// started by updateModules with `process.execPath`: it opens the workspace fresh (the new version's
// files), runs the named units' safe part and the one scoped commit, and writes the result as JSON to
// the file it is given — never to stdout, which a unit's own output may share. Exit 0 means the result
// file holds the outcome (its `code` is the update's); anything else means it does not.
import fs from "node:fs"
import { openWorkspace } from "./api.ts"
import { setupAndCommit } from "./install-modules.ts"

const { root, names, subject, noCommit, out } = JSON.parse(process.argv[2])
try {
  const ws = await openWorkspace(root)
  const r = await setupAndCommit(ws, ws, names, { subject, noCommit, processEnv: process.env })
  fs.writeFileSync(out, JSON.stringify(r))
} catch (e) {
  // one line, as the CLI reports a failure — never Node's trace; the parent names how to finish
  console.error(`✖ ${String(e?.message ?? e).split("\n")[0]}`)
  process.exitCode = 1
}
