import type { Collection } from "../types/Collection.ts"

/** the file a folder-shaped record keeps its fields in */
export function entryOf(c: Collection): string {
  return c.storage.entry ?? "index.md"
}

/** what follows the id in a record's path: `.<suffix>.<format>`, or `/<entry>` for a folder */
export function tail(c: Collection): string {
  return c.storage.shape === "folder" ? `/${entryOf(c)}` : `.${c.storage.suffix}.${c.storage.format}`
}
