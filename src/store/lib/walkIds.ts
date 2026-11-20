import type { Descriptor } from "../../types.ts"
import { storageOf } from "../../record/storageOf.ts"
import { placementOf } from "../../record/placement.ts"
import { placedRecords } from "../../record/placedRecords.ts"
import type { Store } from "../Store.ts"

export function walkIds(store: Store, d: Descriptor, dir: string): Map<string, string> {
  const ids = new Map<string, string>()
  if (storageOf(d).shape === "folder") {
    for (const [id, f] of store._walkRoot(d, dir)) ids.set(id, f)
    return ids
  }
  if (placementOf(d)) {
    // Across every root. FIRST claimant wins and the rest are left for `check` to report as
    // duplicates — never last-one-wins, which would make `get` answer with whichever folder
    // happened to sort later. Ordered by ID, not by where the file sits: a listing whose order
    // changed because a record moved between two companies would be reporting placement, which
    // is not what the reader asked.
    const dupes = new Map<string, string[]>()
    for (const r of placedRecords(d, dir, store.parentDir(d))) {
      if (!ids.has(r.id)) {
        ids.set(r.id, r.file)
        continue
      }
      dupes.set(r.id, [...(dupes.get(r.id) ?? [ids.get(r.id)]), r.file])
    }
    store._duplicates.set(d.name, dupes)
    return new Map([...ids].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  }
  for (const [id, f] of store._walkRoot(d, dir)) ids.set(id, f)
  return ids
}
