import fs from "node:fs"
import type { Store } from "./Store.ts"

export function ids(store: Store, collection: string): Map<string, string> {
  const d = store.descriptor(collection)
  const dir = store.dir(d)
  if (!store.recordDirs(d).some(p => fs.existsSync(p))) return new Map()
  // memoized per collection, keyed by (HEAD sha, collection dir mtime): every tool
  // write commits (HEAD moves) and every store mutation clears its entry below;
  // direct top-level edits move the dir mtime. honest gap: a DEEP direct edit that
  // adds/removes a record without touching HEAD or the top dir mtime can serve one
  // stale read — acceptable, tool writes always commit and `check` covers hand edits.
  const key = store._idsKey(d)
  const hit = store._idsCache.get(collection)
  if (hit?.key === key) return hit.ids
  const ids = store._walkIds(d, dir)
  store._idsCache.set(collection, { key, ids })
  return ids
}
