import { placementOf } from "../../record/placement.ts"
import path from "node:path"
import type { Store } from "../Store.ts"

export function indexAdd(
  store: Store,
  collection: string,
  memo: { key: string; ids: Map<string, string> } | undefined,
  id: string,
  file: string
): void {
  // nothing was memoized before this write, or the mirror pass has already rebuilt it cold from
  // disk — either way a walk is the current answer and this has nothing to add to it.
  if (!memo || store._idsCache.has(collection)) return
  const d = store.descriptor(collection)
  if (store.layered(d)) return // ordered by root, then by walk — the next ids() rebuilds it across every root
  const dir = store.dir(d)
  // a placed collection's order is by ID (see _walkIds), so the insertion point is too
  const byId = !!placementOf(d)
  const isBefore = (k: string, v: string): boolean =>
    byId ? id < k : beforeInWalk(path.relative(dir, file), path.relative(dir, v))
  const ids = new Map<string, string>()
  let placed = false
  for (const [k, v] of memo.ids) {
    if (!placed && isBefore(k, v)) {
      ids.set(id, file)
      placed = true
    }
    ids.set(k, v)
  }
  if (!placed) ids.set(id, file)
  store._idsCache.set(collection, { key: store._idsKey(d), ids })
}

/**
 * Is `a` yielded before `b` by `walk()`? It sorts each directory level and DESCENDS before it
 * yields, so the order is a segment-wise compare of the relative paths and never a plain string
 * one: `2026-01.entry.md` sorts before `2026/x.entry.md` as a string ('-' < '/') and after it in
 * the walk, because readdir meets the directory `2026` first and empties it on the way past.
 */
function beforeInWalk(a: string, b: string): boolean {
  const A = a.split(path.sep)
  const B = b.split(path.sep)
  for (let i = 0; i < Math.min(A.length, B.length); i++) if (A[i] !== B[i]) return A[i] < B[i]
  return A.length < B.length
}
