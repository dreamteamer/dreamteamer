import { SCALARS } from "../model/SCALARS.ts"
import type { Field } from "../types/Field.ts"
import type { Model } from "../types/Model.ts"
import { get } from "./get.ts"
import { listIds } from "./listIds.ts"

function isRef(f: Field) {
  return f.type === "reference" || typeof f.type !== "string" || !SCALARS.has(f.type)
}

/** the records that hold a reference to this one */
export function referrers(model: Model, ref: string): string[] {
  const out: string[] = []
  for (const c of Object.values(model.collections)) {
    const fields = Object.entries(c.fields)
      .filter(([, f]) => isRef(f) && !f.mirror_of)
      .map(([n]) => n)
    if (c.storage.format === "binary" || !fields.length) continue
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
      if (`${c.name}/${id}` !== ref && fields.some((t) => [data[t]].flat().includes(ref))) out.push(`${c.name}/${id}`)
    }
  }
  return out
}
