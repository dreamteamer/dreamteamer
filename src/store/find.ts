import type { Collection } from "../types/Collection.ts"
import type { Model } from "../types/Model.ts"
import type { RecordFile } from "../types/Root.ts"
import { present } from "./present.ts"
import { recordPath } from "./recordPath.ts"
import { rootsOf } from "./rootsOf.ts"

/** the file of a record, from the first of its collection's folders that holds one of this id */
export function find(model: Model, c: Collection, id: string): RecordFile | undefined {
  for (const root of rootsOf(model, c)) {
    const path = recordPath(model, c, id, root.dir)
    if (present(root.dir, path)) {
      const res: RecordFile = { path, root }
      return res
    }
  }
  return undefined
}
