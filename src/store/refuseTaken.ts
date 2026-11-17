import { DtError } from "../lib/DtError.ts"
import type { Collection } from "../types/Collection.ts"
import type { Issue } from "../types/Issue.ts"
import type { Model } from "../types/Model.ts"
import { get } from "./get.ts"
import { listIds } from "./listIds.ts"

/** whether a value claims a unique field: null, absent and empty text never do */
export function claims(v: unknown) {
  return v !== undefined && v !== null && v !== ""
}

/**
 * Refuse a write whose value of a `unique` field another record of the collection already holds. Only the fields
 * being written are asked, as the released engine asks them: a conflict an unrelated edit does not touch is check's
 * to report.
 */
export function refuseTaken(model: Model, c: Collection, id: string, data: Record<string, unknown>, keys: string[]) {
  const names = keys.filter((t) => c.fields[t]?.unique && !c.fields[t].many && claims(data[t]))
  if (!names.length) return
  const issues: Issue[] = []
  for (const other of listIds(model, c.name)) {
    if (other === id) continue
    let held: Record<string, unknown>
    try {
      held = get(model, `${c.name}/${other}`).data
    } catch {
      continue
    }
    for (const n of names)
      if (held[n] === data[n])
        issues.push({
          severity: "error",
          where: `${c.name}/${id}`,
          message: `${n}: "${String(data[n])}" is already taken by ${c.name}/${other} (unique)`,
        })
  }
  if (issues.length) throw new DtError(`${c.name}/${id} rejected — nothing written`, issues)
}
