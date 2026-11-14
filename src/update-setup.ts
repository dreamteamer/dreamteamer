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
