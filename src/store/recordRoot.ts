import type { Descriptor } from "../types.ts"
import { assertSafeId } from "../record/records.ts"
import { storageOf } from "../record/storageOf.ts"
import path from "node:path"
import { placementOf } from "../record/placement.ts"
import type { Store } from "./Store.ts"

export function recordRoot(store: Store, d: Descriptor, id: string): string {
  assertSafeId(id)
  if (storageOf(d).shape === "folder") return path.join(store.dir(d), id)
  // Only the index knows an opaque record's extension, so the on-disk unit is looked up rather
  // than derived. An unknown id is the caller's error either way — `read` says so first. The same
  // goes for a placed record: which parent folder it sits in is a fact about the file, not the id.
  if (storageOf(d).format === "binary" || placementOf(d)) {
    const file = store.ids(d.name).get(id)
    if (!file) throw new Error(`${d.name}/${id}: no such record`)
    return file
  }
  return store.filePath(d, id)
}
