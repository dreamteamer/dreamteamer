import fs from "node:fs"
import path from "node:path"
import { commentCount } from "../../lib/yaml.ts"
import type { Workspace } from "../../types.ts"
import type { Snapshot } from "../types.ts"

/**
 * A SOURCE WRITE MAY NOT SILENTLY LOSE A COMMENT — the invariant that would have caught the
 * re-serialization bug on the first rename instead of the twenty-seventh.
 *
 * A module source is where this project writes down WHY a collection exists, and every gate it had
 * was blind to losing that: the schema is unchanged, so `compile` and `check` both stay green while
 * the reasoning is deleted. Counting comment lines is crude on purpose — it is structural, it costs
 * one pass over bytes already in hand, and it fails the op rather than reporting it afterwards.
 *
 * ⚠ THE OPT-OUT IS REAL AND NARROW. `rm-field` takes the comment ABOVE the field with the field,
 * which is the correct outcome and a decrease; so does deleting a file. Those ops say so explicitly
 * (`commentsMayDecrease`) rather than being exempted by a heuristic that would also excuse a bug.
 */
export function assertCommentsKept(ws: Workspace, snapshots: Snapshot[]): void {
  for (const { f, prev } of snapshots) {
    if (prev === null || !fs.existsSync(f)) continue
    const before = commentCount(prev.toString("utf8"))
    const after = commentCount(fs.readFileSync(f, "utf8"))
    if (after >= before) continue
    throw new Error(
      `${path.relative(ws.root, f)} would lose ${before - after} comment line(s) — a source write may not delete a module's own reasoning. Nothing was changed.`
    )
  }
}
