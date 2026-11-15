import type { Descriptor } from "../../types.ts"
import type { Under } from "../../record/types.ts"
import { storageOf } from "../../record/storageOf.ts"
import { placementOf } from "../../record/placement.ts"
import { rootRecords } from "../../record/lib/rootRecords.ts"
import path from "node:path"
import type { Store } from "../Store.ts"

export function placedChildrenIn(
  store: Store,
  d: Descriptor,
  unit: string
): { collection: string; under: Under; count: number }[] {
  const out: { collection: string; under: Under; count: number }[] = []
  if (storageOf(d).shape !== "folder") return out
  for (const c of store.descriptors.values()) {
    const under = placementOf(c)
    if (under?.collection !== d.name) continue
    const n = [...rootRecords(c, path.join(unit, under.subfolder))].length
    if (n) out.push({ collection: c.name, under, count: n })
  }
  return out
}
