import type { Descriptor, Fields } from "../../types.ts"
import { assertSafeId } from "../../record/records.ts"
import { storageOf } from "../../record/storageOf.ts"
import path from "node:path"
import { placementOf, isNested, parentOfNestedId, localOfNestedId } from "../../record/placement.ts"
import { ownerIdOf } from "../../record/ownerIdOf.ts"
import { parseRef } from "../../record/parseRef.ts"
import type { Store } from "../Store.ts"
import { recordFileName } from "./recordFileName.ts"

export function filePath(store: Store, d: Descriptor, id: string, ext?: string, fields?: Fields): string {
  assertSafeId(id) // never fs-join an id that can climb out of the collection
  if (storageOf(d).shape === "folder") {
    if (!storageOf(d).entry) throw new Error(`collection "${d.name}" is folder-shape but declares no storage.entry`)
    return path.join(store.dir(d), id, storageOf(d).entry)
  }
  if (storageOf(d).format === "binary") {
    // An opaque record's extension is not derivable from its id. A caller that WRITES says what
    // it is; a caller that reads goes through the id index instead (recordRoot, below).
    if (!ext) throw new Error(`collection "${d.name}" is \`format: binary\` — its path needs the file's extension`)
    return path.join(store.dir(d), `${id}.${storageOf(d).suffix}.${ext}`)
  }
  const under = placementOf(d)
  if (isNested(under) && fields) {
    const parentId = ownerIdOf(fields, under, v => parseRef(v, store.namespaces))
    if (parentId) {
      if (parentOfNestedId(id) !== parentId || !id.includes("/"))
        throw new Error(
          `${d.name}/${id}: the id must begin with its ${under.parent}'s id ("${parentId}/…") — ids of ${d.name} are nested under their parent. nothing was written.`
        )
      return path.join(store.rootFor(d, fields), recordFileName(d, localOfNestedId(id)))
    }
  }
  return path.join(store.rootFor(d, fields), recordFileName(d, id))
}
