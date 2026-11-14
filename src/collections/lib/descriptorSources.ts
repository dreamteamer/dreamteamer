import fs from "node:fs"
import type { Store } from "../../store/Store.ts"
import { walk } from "../../lib/walk.ts"
import type { Workspace } from "../../types.ts"
import { kindDir } from "../../workspace/compile.ts"

/** Every workspace-owned descriptor source, recursively (namespaced descriptors are nested). */
export function descriptorSources(ws: Workspace, store: Store): string[] {
  const out: string[] = []
  for (const root of store.sourceRoots()) {
    const dir = kindDir(root, "collections")
    // ⚠ SPREAD FIRST. `walk` is a GENERATOR, and `Iterator.prototype.filter` is a Node 22 iterator
    // helper — so `walk(dir).filter(...)` works on 22 and throws "filter is not a function" on 20,
    // which package.json still supports (`"node": ">=20"`). Caught by the CI matrix, not by local runs.
    if (fs.existsSync(dir)) out.push(...[...walk(dir)].filter(f => f.endsWith(".collection.yaml")))
  }
  return out
}
