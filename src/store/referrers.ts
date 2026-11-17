import { isObject } from "../lib/isObject.ts"
import { SCALARS } from "../model/SCALARS.ts"
import type { Field } from "../types/Field.ts"
import type { Model } from "../types/Model.ts"
import { get } from "./get.ts"
import { listIds } from "./listIds.ts"

function isRef(f: Field) {
  return f.type === "reference" || typeof f.type !== "string" || !SCALARS.has(f.type)
}

/** whether a field can hold a reference that is followed: its own, or one inside its objects */
function holds(f: Field): boolean {
  return !f.mirror_of && (isRef(f) || Object.values(f.fields ?? {}).some(holds))
}

/** the references a field's value holds, those inside its objects too; a map's values are only text */
function refsOf(f: Field, v: unknown): unknown[] {
  if (f.mirror_of) return []
  if (f.type === "object")
    return [v]
      .flat()
      .filter(isObject)
      .flatMap((o) => Object.entries(f.fields ?? {}).flatMap(([k, s]) => refsOf(s, o[k])))
  return isRef(f) ? [v].flat() : []
}

/** the records that hold a reference to this one */
export function referrers(model: Model, ref: string): string[] {
  const out: string[] = []
  for (const c of Object.values(model.collections)) {
    const fields = Object.entries(c.fields).filter(([, f]) => holds(f))
    if (c.storage.format === "binary" || model.sources[c.name] || !fields.length) continue
    let ids: string[]
    try {
      ids = listIds(model, c.name)
    } catch {
      continue
    }
    for (const id of ids) {
      let data: Record<string, unknown>
      try {
        data = get(model, `${c.name}/${id}`).data
      } catch {
        continue
      }
      if (`${c.name}/${id}` !== ref && fields.some(([n, f]) => refsOf(f, data[n]).includes(ref)))
        out.push(`${c.name}/${id}`)
    }
  }
  return out
}
