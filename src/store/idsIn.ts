import { existsSync } from "node:fs"
import { relative, sep } from "node:path"
import { listFiles } from "../lib/listFiles.ts"
import type { Collection } from "../types/Collection.ts"
import { tail } from "./tail.ts"

/** the records of a collection's kind below a folder, by id in order: each file's path there, less its tail */
export function idsIn(base: string, c: Collection): Map<string, string> {
  const end = tail(c)
  if (!existsSync(base)) return new Map()
  const ids = listFiles(base)
    .filter((t) => t.endsWith(end))
    .map((t): [string, string] => [relative(base, t).slice(0, -end.length).split(sep).join("/"), t])
    .filter(([t]) => t && !t.endsWith("/"))
  return new Map(ids.sort(([a], [b]) => (a < b ? -1 : 1)))
}
