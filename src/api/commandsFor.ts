import { textOf } from "./compareValues.ts"
import { matchesFilter } from "./matchesFilter.ts"
import { parseRef } from "./parseRef.ts"
import type { Store } from "./Store.ts"

/** a memoised reader of the record a reference names, its id included; null when it does not resolve */
export function recordResolver(store: Store) {
  const memo = new Map<string, Record<string, unknown> | null>()
  return (ref: string) => {
    if (memo.has(ref)) return memo.get(ref) ?? null
    let target: Record<string, unknown> | null = null
    const at = parseRef(ref, store.namespaces)
    if (at)
      try {
        target = Object.assign({}, store.read(at.collection, at.id).fields, { id: at.id })
      } catch {
        // a dangling reference or an unknown collection narrows a filter, never widens it
      }
    memo.set(ref, target)
    return target
  }
}

/** a command as typed: its name after a slash, a namespace's slashes as colons */
function slash(name: unknown) {
  return `/${textOf(name).replace(/\//g, ":")}`
}

/**
 * Every command bound to a collection, as the released engine evaluates its bindings: a collection-scoped one always
 * runs; a record-scoped one is, per id, `done` when its `done_when` holds, `available` when its `available_when` does
 * (or it has none), else `not-applicable`. Record commands first, then collection ones, each by name.
 */
export function commandsFor(store: Store, collection: string, ids: string[] = []) {
  store.descriptor(collection)
  const resolve = recordResolver(store)
  const commands = new Map<string, Record<string, unknown>>()
  for (const t of store.readAll("commands")) commands.set(`commands/${t.id}`, t.fields)
  const rows: Record<string, unknown>[] = []
  for (const { id: binding, fields: b } of store.readAll("command-bindings")) {
    const cmd = typeof b.command === "string" ? commands.get(b.command) : undefined
    if (b.collection !== `collections/${collection}` || !cmd) continue
    const row: Record<string, unknown> = {
      binding: `command-bindings/${binding}`,
      command: b.command,
      name: cmd.name,
      description: b.description ?? cmd.description ?? "",
      "argument-hint": cmd["argument-hint"] ?? null,
      scope: b.scope ?? "record",
    }
    if (row.scope === "collection") {
      rows.push(Object.assign(row, { invocation: `${slash(cmd.name)} ${collection}` }))
      continue
    }
    const states: Record<string, string> = {}
    for (const id of ids) {
      const r = resolve(`${collection}/${id}`)
      states[id] = !r
        ? "not-applicable"
        : b.done_when && matchesFilter(r, b.done_when, resolve)
          ? "done"
          : !b.available_when || matchesFilter(r, b.available_when, resolve)
            ? "available"
            : "not-applicable"
    }
    const eligible = ids.filter((t) => states[t] === "available")
    const invocation = eligible.length
      ? `${slash(cmd.name)} ${eligible.map((t) => `${collection}/${t}`).join(" ")}`
      : null
    rows.push(Object.assign(row, { states, eligible, done: ids.filter((t) => states[t] === "done"), invocation }))
  }
  rows.sort((x, y) =>
    x.scope === y.scope ? textOf(x.name).localeCompare(textOf(y.name)) : x.scope === "collection" ? 1 : -1,
  )
  const res = { collection, ids, commands: rows }
  return res
}
