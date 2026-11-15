import { storageOf } from "../record/storageOf.ts"
import path from "node:path"
import fs from "node:fs"
import { walk } from "../lib/walk.ts"
import type { Store } from "./Store.ts"

export function* recordFiles(store: Store) {
  const seen = new Set()
  for (const d of store.descriptors.values()) {
    if (storageOf(d).unavailable) continue // an env-pointed root this machine cannot render: nothing to walk
    // for runtime-based collections, inbound-ref surgery targets SOURCES, not the runtime
    // a layer's records name records of this workspace too, so a removal or a rename must see them
    const dirs = storageOf(d).runtime
      ? store.sourceRoots().map(r => path.join(r, storageOf(d).path))
      : store.rootsOf(d).map(r => r.abs)
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue
      for (const f of walk(dir)) {
        const key = path.resolve(f)
        if (seen.has(key)) continue
        seen.add(key)
        yield f
      }
    }
  }
}
