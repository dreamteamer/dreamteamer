import { recordChanges } from "./recordChanges.ts"
import { Store } from "../record/Store.ts"
import { emit } from "../record/emit.ts"
import { groupChanges } from "../record/groupChanges.ts"
import { printChanges } from "../record/printChanges.ts"
import type { Workspace } from "../types.ts"
import { warnIfStale } from "../workspace/compile.ts"

// `changes` is what survives of the trigger/run subsystem removed 2026-07-31: deriving
// record events from git history was the genuinely used half (catch-up — "what happened
// while I was away"), while creating run records from triggers was not. Read-only by
// construction: no cursor to advance, nothing to store, so it is safe to run twice.
// Since 0.42.0 its default is the UNCOMMITTED state (`HEAD`), because the question a
// session asks after a write is "what did I just change" — and its first line is the
// report line the skill tells a session to end its reply with.
export function changesCommand(ws: Workspace, rest: string[]): number {
  warnIfStale(ws.root)
  const si = rest.indexOf("--since")
  if (si > -1 && (!rest[si + 1] || rest[si + 1].startsWith("-")))
    throw new Error(
      "--since needs a commit or a date: dt changes --since <sha|YYYY-MM-DD> (bare `dt changes` is the uncommitted state)"
    )
  const since = si > -1 ? rest[si + 1] : "HEAD"
  const events = recordChanges(new Store(ws), { since })
  if (rest.includes("--json")) {
    emit(
      JSON.stringify(
        { since, head: "HEAD", events, collections: groupChanges(events).map(({ records, ...g }) => g) },
        null,
        2
      )
    )
    return 0
  }
  if (!events.length) {
    console.log(`✔ no record changes since ${since}`)
    return 0
  }
  printChanges(events)
  const open = events.filter(e => !e.committed).length
  console.log(`${events.length} record change(s) since ${since} — ${open ? `${open} uncommitted` : "all committed"}`)
  return 0
}
