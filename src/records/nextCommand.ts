import type { Workspace, Flags } from "../types.ts"
import { Store } from "../store/Store.ts"
import { need } from "../lib/need.ts"
import { oneValue } from "../lib/oneValue.ts"
import { commandsFor } from "./commandsFor.ts"
import { contributedNotes } from "./lib/contributedNotes.ts"
import { emit } from "../lib/emit.ts"

/**
 * Which bound commands apply, in which state (available / done / not-applicable). THE engine
 * surface behind the studio's Commands tab (engine/UI parity: the verb lands first, the button
 * second).
 *
 * ⚠ The COLLECTION arrives already resolved, and the ids only ever through `--ids`. This used to
 * split its own target at the first slash — which cannot name a namespaced collection, so
 * `commands finance/transactions` asked for a collection called "finance" and every namespaced
 * target failed. `cli.js` owns reference resolution now (splitRef, longest declared prefix) and is
 * the only caller, so a second, weaker splitter here could only ever disagree with it.
 */
function metaCommandsFor(ws: Workspace, store: Store, flags: Flags, pos: string[]) {
  const collection = need(pos, 0, "collection")
  const ids = (oneValue(flags, "ids") ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
  const out = commandsFor(store, collection, ids)
  // what an installed extension says about these records (a session holding one, say) — after the
  // commands, because the commands are the answer and a note is context for it
  const notes = contributedNotes(ws, collection, ids)
  if (flags.json) {
    emit(JSON.stringify({ ...out, notes }, null, 2))
    return 0
  }
  if (!out.commands.length) console.log(`(no commands bound to ${collection})`)
  for (const c of out.commands) {
    if (c.scope === "collection") {
      console.log(`${c.name}  [collection]  ${c.invocation}`)
      continue
    }
    const counts = ids.length
      ? `  ${c.eligible.length}/${ids.length} eligible${c.done.length ? `, ${c.done.length} done` : ""}`
      : "  (no ids given)"
    console.log(`${c.name}  [record]${counts}${c.invocation ? `\n  ${c.invocation}` : ""}`)
  }
  for (const n of notes) console.log(n.error ? `✖ ${n.by}: ${n.text}` : `● ${collection}/${n.id} — ${n.text} (${n.by})`)
  return 0
}

/** `dt next` — reached as `commands for <collection>` — or null for any other verb. */
export function nextCommand(
  ws: Workspace,
  store: Store,
  collection: string,
  verb: string,
  flags: Flags,
  pos: string[]
): number | null {
  if (collection === "commands" && verb === "for") return metaCommandsFor(ws, store, flags, pos)
  return null
}
