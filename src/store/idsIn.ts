import { existsSync } from "node:fs"
import { relative, sep } from "node:path"
import { listFiles } from "../lib/listFiles.ts"
import type { Collection } from "../types/Collection.ts"
import { tail } from "./tail.ts"

/** the ids of the records of a collection's kind below a folder, sorted: each file's path there, less its tail */
export function idsIn(base: string, c: Collection): string[] {
  const end = tail(c)
  if (!existsSync(base)) return []
  return listFiles(base)
    .filter((t) => t.endsWith(end))
    .map((t) => relative(base, t).slice(0, -end.length).split(sep).join("/"))
    .filter((t) => t && !t.endsWith("/"))
    .sort()
}
