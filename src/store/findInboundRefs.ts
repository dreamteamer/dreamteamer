import fs from "node:fs"
import path from "node:path"
import type { Store } from "./Store.ts"

export function findInboundRefs(store: Store, ref: string): string[] {
  const re = store.refRegex(ref)
  const hits = []
  for (const f of store.recordFiles()) {
    const text = fs.readFileSync(f, "utf8")
    re.lastIndex = 0
    if (re.test(text)) hits.push(path.relative(store.root, f))
  }
  return hits
}
