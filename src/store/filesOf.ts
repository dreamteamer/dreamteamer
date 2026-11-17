import type { Collection } from "../types/Collection.ts"
import type { Model } from "../types/Model.ts"
import type { RecordFile } from "../types/Root.ts"
import { idsIn } from "./idsIn.ts"
import { rootsOf } from "./rootsOf.ts"

/** every file of every record of a collection, by id: the first answers for it, any other is a duplicate */
export function filesOf(model: Model, c: Collection): Map<string, RecordFile[]> {
  const res = new Map<string, RecordFile[]>()
  for (const root of rootsOf(model, c))
    for (const [id, path] of idsIn(root.dir, c)) res.set(id, [...(res.get(id) ?? []), { path, root }])
  return res
}
