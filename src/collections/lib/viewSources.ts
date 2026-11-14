import fs from "node:fs"
import type { Store } from "../../store/Store.ts"
import { walk } from "../../lib/walk.ts"
import { kindDir } from "../../workspace/compile.ts"

/** The ui-views and command-bindings of every source root, with the collection each one is over. */
export function viewSources(store: Store): { file: string; kind: string }[] {
  const out: { file: string; kind: string }[] = []
  for (const root of store.sourceRoots()) {
    for (const kind of ["ui-views", "command-bindings"]) {
      const dir = kindDir(root, kind)
      if (!fs.existsSync(dir)) continue
      for (const file of [...walk(dir)]) {
        if (!/\.(ui-view|command-binding)\.yaml$/.test(file)) continue
        out.push({ file, kind })
      }
    }
  }
  return out
}
