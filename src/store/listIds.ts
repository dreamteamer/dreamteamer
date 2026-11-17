import { existsSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { listFiles } from "../lib/listFiles.ts"
import type { Model } from "../types/Model.ts"
import { openCollection } from "./openCollection.ts"
import { tail } from "./tail.ts"

/** the ids of a collection's records, sorted */
export function listIds(model: Model, name: string): string[] {
  const c = openCollection(model, name)
  const base = join(model.root, c.storage.path)
  const end = tail(c)
  if (!existsSync(base)) return []
  return listFiles(base)
    .filter((t) => t.endsWith(end))
    .map((t) => relative(base, t).slice(0, -end.length).split(sep).join("/"))
    .filter((t) => t && !t.endsWith("/"))
    .sort()
}
