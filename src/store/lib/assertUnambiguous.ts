import { placementOf } from "../../record/placement.ts"
import path from "node:path"
import type { Store } from "../Store.ts"

export function assertUnambiguous(store: Store, collection: string, id: string): void {
  const d = store.descriptor(collection)
  if (!placementOf(d)) return
  store.ids(collection) // ensures the duplicate memo is current
  const dupes = store._duplicates.get(collection)?.get(id)
  if (dupes)
    throw new Error(
      `${collection}/${id} is held by ${dupes.length} files — ${dupes.map(f => path.relative(store.root, f)).join(" and ")}. Remove one before writing to it (dreamteamer check names them). nothing was written.`
    )
}
