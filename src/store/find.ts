import { existsSync, readdirSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import type { Collection } from "../types/Collection.ts"
import type { Model } from "../types/Model.ts"
import type { RecordFile } from "../types/Root.ts"
import { present } from "./present.ts"
import { recordPath } from "./recordPath.ts"
import { rootsOf } from "./rootsOf.ts"

/** the file of a record, from the first of its collection's folders that holds one of this id */
export function find(model: Model, c: Collection, id: string): RecordFile | undefined {
  for (const root of rootsOf(model, c)) {
    let path = recordPath(model, c, id, root.dir)
    // a binary record's extension is the file's own: the one file named <id>.<suffix>.<extension>
    const dir = dirname(path)
    if (c.storage.format === "binary" && existsSync(dir)) {
      const end = `${basename(id)}.${c.storage.suffix}.`
      path = join(
        dir,
        readdirSync(dir).find((t) => t.startsWith(end) && /^[A-Za-z0-9]+$/.test(t.slice(end.length))) ?? "",
      )
    }
    if (present(root.dir, path)) {
      const res: RecordFile = { path, root }
      return res
    }
  }
  return undefined
}
