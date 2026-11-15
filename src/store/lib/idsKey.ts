import type { Descriptor } from "../../types.ts"
import fs from "node:fs"
import { placementOf } from "../../record/placement.ts"
import { dirTreeStamps } from "./dirTreeStamps.ts"
import type { Store } from "../Store.ts"

export function idsKey(store: Store, d: Descriptor): string {
  const stamp = (p: string): string => {
    try {
      return String(fs.statSync(p).mtimeMs)
    } catch {
      return "-"
    }
  }
  if (!placementOf(d) && !store.layered(d)) return `${store.gitHead()}:${stamp(store.dir(d))}`
  // A placed collection's records sit three levels down in folders this process did not create,
  // and another writer (an agent, the editor, a hand) adds or removes one without touching a
  // root's own mtime — so a root-mtime key served a long-lived Store a stale index (R4). Every
  // DIRECTORY in every root is stamped instead: O(directories), which is small, and a new or
  // vanished folder changes the string as surely as a changed one. A LAYER is the same shape:
  // `dt update` pulls files into it without moving this workspace's HEAD or any root's mtime.
  const dirs = store.recordDirs(d)
  return `${store.gitHead()}:${dirs.map(dirTreeStamps).join("|")}`
}
