import { matchesFilter } from "./matchesFilter.ts"
import { recordResolver } from "./recordResolver.ts"
import type { Store } from "../record/Store.ts"
import { slash } from "../record/namespace.ts"
import type { CommandRow } from "../types.ts"

/**
 * every command bound to `collection`, evaluated over `ids` (possibly empty).
 * scope=collection bindings need no record — always runnable, invocation carries the
 * collection name (so a command bound to several collections knows where to write).
 * scope=record bindings get a per-id state:
 *   done            done_when passes (the command's post-condition already holds)
 *   available       available_when passes (or there is none) and done_when doesn't
 *   not-applicable  available_when fails (or the record doesn't resolve)
 * `invocation` covers the ELIGIBLE ids only, space-separated — a deliberate contract:
 * the UI shows it verbatim in an editable textarea, so nothing is silently dropped.
 */
export function commandsFor(
  store: Store,
  collection: string,
  ids: string[] = []
): { collection: string; ids: string[]; commands: CommandRow[] } {
  store.descriptor(collection) // unknown collection throws here, not deep inside a filter walk
  const resolve = recordResolver(store)
  const commands = new Map()
  for (const { id, fields } of store.readAll("commands")) commands.set(`commands/${id}`, fields)
  const rows: CommandRow[] = []
  for (const { id: bindingId, fields: b } of store.readAll("command-bindings")) {
    if (b.collection !== `collections/${collection}`) continue
    const cmd = commands.get(b.command)
    if (!cmd) continue // compile rejects dangling binding refs; stay safe on a stale runtime
    // the core `commands` and `command-bindings` collections' schemas make these strings
    const row = {
      binding: `command-bindings/${bindingId}`,
      command: b.command as string,
      name: cmd.name as string,
      description: (b.description ?? cmd.description ?? "") as string,
      "argument-hint": (cmd["argument-hint"] ?? null) as string | null,
      scope: (b.scope ?? "record") as string,
    }
    if (row.scope === "collection") {
      rows.push({ ...row, invocation: `${slash(cmd.name)} ${collection}` })
      continue
    }
    const states: CommandRow["states"] = {}
    for (const id of ids) {
      const record = resolve(`${collection}/${id}`)
      let state: "available" | "done" | "not-applicable" = "not-applicable"
      if (record) {
        if (b.done_when && matchesFilter(record, b.done_when, resolve)) state = "done"
        else if (!b.available_when || matchesFilter(record, b.available_when, resolve)) state = "available"
      }
      states[id] = state
    }
    const eligible = ids.filter(id => states[id] === "available")
    rows.push({
      ...row,
      states,
      eligible,
      done: ids.filter(id => states[id] === "done"),
      invocation: eligible.length ? `${slash(cmd.name)} ${eligible.map(id => `${collection}/${id}`).join(" ")}` : null,
    })
  }
  // record commands first (the headline on a record page), then collection commands; name-sorted within
  rows.sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === "collection" ? 1 : -1))
  return { collection, ids, commands: rows }
}
