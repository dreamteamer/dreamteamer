import type { Descriptor } from "../../types.ts"
import fs from "node:fs"
import path from "node:path"
import type { Store } from "../Store.ts"
import type { Undo } from "../types.ts"

export function moveRecord(store: Store, d: Descriptor, from: string, to: string): Undo {
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.renameSync(from, to)
  } catch (e) {
    store._pruneAround(d, to) // the folders a failed move created, and nothing more
    throw e
  }
  // The undo exists from the moment the rename has happened, and anything that fails AFTER it
  // runs the undo before it propagates (R1b): a cleanup that threw used to leave the caller with
  // no undo and both copies on disk. Pruning itself no longer throws (pruneEmptyDirs), so this
  // is the belt to that brace.
  const undo = () => {
    fs.mkdirSync(path.dirname(from), { recursive: true })
    fs.renameSync(to, from)
    store._pruneAround(d, to)
  }
  try {
    store._pruneAround(d, from)
  } catch (e) {
    undo()
    throw e
  }
  return undo
}
