import { textOf } from "../lib/compareValues.ts"
import { DtError } from "../lib/DtError.ts"
import { findCollection } from "../model/findCollection.ts"
import type { Model } from "../types/Model.ts"
import { get } from "./get.ts"
import { listIds } from "./listIds.ts"
import { matchesFilter } from "./matchesFilter.ts"

/** a command as typed: its name after a slash, a namespace's slashes as colons */
function slash(name: unknown) {
  return `/${textOf(name).replace(/\//g, ":")}`
}

/**
 * Every command bound to a collection, as the released engine evaluates its bindings: a collection-scoped one always
 * runs; a record-scoped one is, per id, `done` when its `done_when` holds, `available` when its `available_when` does
 * (or it has none), else `not-applicable`. A gate is a record filter: it may follow a reference one hop
 * (`implementation_plans: {status: {_eq: done}}`), and a reference that does not resolve narrows it. Record commands
 * come first, then collection ones, each by name.
 */
export function commandsFor(model: Model, collection: string, ids: string[] = []) {
  const name = findCollection(model, collection)?.name
  if (!name) throw new DtError(`unknown collection ${collection}`)
  const memo = new Map<string, Record<string, unknown> | null>()
  const resolve = (ref: string) => {
    if (!memo.has(ref))
      try {
        const r = get(model, ref)
        memo.set(ref, Object.assign({}, r.data, { id: r.id }))
      } catch {
        memo.set(ref, null)
      }
    return memo.get(ref) ?? null
  }
  const rows: Record<string, unknown>[] = []
  // in the order of their files, as the released engine reads them: `<id>--code.…` before `<id>.…`
  const files = listIds(model, "command-bindings").map((t) => t + ".")
  for (const id of files.sort().map((t) => t.slice(0, -1))) {
    const b = resolve(`command-bindings/${id}`) ?? {}
    const cmd = typeof b.command === "string" ? resolve(b.command) : null
    if (b.collection !== `collections/${name}` || !cmd) continue
    const row: Record<string, unknown> = {
      binding: `command-bindings/${id}`,
      command: b.command,
      name: cmd.name,
      description: b.description ?? cmd.description ?? "",
      "argument-hint": cmd["argument-hint"] ?? null,
      scope: b.scope ?? "record",
    }
    if (row.scope === "collection") {
      rows.push(Object.assign(row, { invocation: `${slash(cmd.name)} ${name}` }))
      continue
    }
    const states: Record<string, string> = {}
    for (const t of ids) {
      const r = resolve(`${name}/${t}`)
      states[t] = !r
        ? "not-applicable"
        : b.done_when && matchesFilter(r, b.done_when, resolve)
          ? "done"
          : !b.available_when || matchesFilter(r, b.available_when, resolve)
            ? "available"
            : "not-applicable"
    }
    const eligible = ids.filter((t) => states[t] === "available")
    const invocation = eligible.length ? `${slash(cmd.name)} ${eligible.map((t) => `${name}/${t}`).join(" ")}` : null
    rows.push(Object.assign(row, { states, eligible, done: ids.filter((t) => states[t] === "done"), invocation }))
  }
  rows.sort((x, y) =>
    x.scope === y.scope ? textOf(x.name).localeCompare(textOf(y.name)) : x.scope === "collection" ? 1 : -1,
  )
  const res = { collection: name, ids, commands: rows }
  return res
}
