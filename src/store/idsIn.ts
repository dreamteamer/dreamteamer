import { existsSync } from "node:fs"
import { relative, sep } from "node:path"
import { listFiles } from "../lib/listFiles.ts"
import type { Collection } from "../types/Collection.ts"
import { tail } from "./tail.ts"

/** where the tail of a binary record's file name begins (`<id><end><extension>`), or -1 */
export function opaque(name: string, end: string): number {
  const i = name.lastIndexOf(end)
  return i > 0 && /^[A-Za-z0-9]+$/.test(name.slice(i + end.length)) ? i : -1
}

/**
 * the records of a collection's kind below a folder, by id in order: each file's path there, less its tail — for a
 * binary record, `.<suffix>.<extension>`, the extension being the file's own
 */
export function idsIn(base: string, c: Collection): Map<string, string> {
  const end = c.storage.format === "binary" ? `.${c.storage.suffix}.` : tail(c)
  const at = (t: string) =>
    c.storage.format === "binary" ? opaque(t, end) : t.endsWith(end) ? t.length - end.length : -1
  if (!existsSync(base)) return new Map()
  const ids = listFiles(base)
    .filter((t) => at(t) > 0)
    .map((t): [string, string] => [
      relative(base, t.slice(0, at(t)))
        .split(sep)
        .join("/"),
      t,
    ])
    .filter(([t]) => t && !t.endsWith("/"))
  return new Map(ids.sort(([a], [b]) => (a < b ? -1 : 1)))
}
