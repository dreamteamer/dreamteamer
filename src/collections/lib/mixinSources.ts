import fs from "node:fs"
import type { Store } from "../../store/Store.ts"
import { walk } from "../../lib/walk.ts"
import { kindDir } from "../../workspace/compile.ts"

/** Every mixin source, by id — a mixin is shared by every collection that lists it. */
export function mixinSources(store: Store): { id: string; file: string }[] {
  const out: { id: string; file: string }[] = []
  for (const root of store.sourceRoots()) {
    const dir = kindDir(root, "mixins")
    if (!fs.existsSync(dir)) continue
    for (const file of [...walk(dir)]) {
      const m = /([^/\\]+)\.mixin\.yaml$/.exec(file)
      if (m) out.push({ id: m[1], file })
    }
  }
  return out
}
