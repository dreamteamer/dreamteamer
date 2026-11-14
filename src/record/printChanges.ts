import { ROWS_SHOWN } from "./consts.ts"
import { groupChanges } from "./groupChanges.ts"
import { reportLine } from "./lib/reportLine.ts"
import type { RecordChange } from "./types.ts"

/** The record-change report: the report line, then one row per record — its change, ref, workspace
 *  path (what a reply links to), committed or not, and the layer it landed in — capped like every
 *  other listing here. `dt changes` and `dt commit` print it identically, so what a session copies
 *  into its reply does not depend on which of the two it ran. */
export function printChanges(changes: (RecordChange & { committed?: boolean; sha?: string | null })[]): void {
  const groups = groupChanges(changes)
  console.log(reportLine(groups))
  const rows = groups.flatMap(g => g.records)
  for (const c of rows.slice(0, ROWS_SHOWN)) {
    const state = c.committed ? `committed${c.sha ? ` ${c.sha}` : ""}` : "uncommitted"
    console.log(`  ${c.change.padEnd(7)}  ${c.ref}  ${c.path}  · ${state}${c.layer ? ` · layer ${c.layer}` : ""}`)
  }
  if (rows.length > ROWS_SHOWN) console.log(`  + ${rows.length - ROWS_SHOWN} more — --json lists every record`)
}
