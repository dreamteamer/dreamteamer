import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { Collection } from "../types/Collection.ts"
import type { Model } from "../types/Model.ts"
import type { Root } from "../types/Root.ts"

/**
 * the folders a collection's records are read from, in the order an id is looked up: its own first, then, for one
 * stored under its owners, the folder each owner lends it, by owner id; then each record layer's. A folder reached through a link is not read.
 */
export function rootsOf(model: Model, c: Collection): Root[] {
  const res: Root[] = [{ dir: join(model.root, c.storage.path) }]
  const p = c.under && join(model.root, model.collections[c.under.collection].storage.path)
  if (c.under && p && existsSync(p))
    for (const e of readdirSync(p, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)))
      if (e.isDirectory() && !e.name.startsWith("."))
        res.push({ dir: join(p, e.name, c.under.subfolder), parent: e.name })
  for (const l of c.layers ?? []) res.push({ dir: join(model.root, l.path), layer: l.name })
  return res
}
