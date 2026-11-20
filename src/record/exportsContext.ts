import path from "node:path"
import fs from "node:fs"
import { storageOf } from "./storageOf.ts"
import type { ExportsContext } from "./types.ts"
import { walk } from "../lib/walk.ts"
import type { Descriptors, Storage } from "../types.ts"

/**
 * Is every file under `dataDir` inside one of the `reads` folders (paths relative to `root`)? Judged on
 * the disk NOW, so a folder a pull added after compile makes the workspace incomplete without a recompile.
 */
function readsAll(root: string, dataDir: string, reads: string[]): boolean {
  const abs = path.join(root, dataDir)
  if (!fs.existsSync(abs)) return true
  const prefixes = reads.map(r => path.join(root, r) + path.sep)
  for (const f of walk(abs)) if (!prefixes.some(p => f.startsWith(p))) return false
  return true
}

/** The one context every exports judgement uses; `own` is this workspace's package name. */
export function exportsContext({
  root,
  descriptors,
  own,
  dataPath = "data",
}: {
  root: string
  descriptors: Descriptors
  own: string | null
  dataPath?: string
}): ExportsContext {
  const complete = (): boolean => {
    const reads: string[] = []
    for (const d of descriptors.values()) {
      if (storageOf(d).unavailable) return false
      if (
        (storageOf(d) as Storage & { base?: string }).base !== "runtime" &&
        !path.isAbsolute(storageOf(d).path) &&
        !storageOf(d).path.includes("${")
      )
        reads.push(storageOf(d).path)
    }
    return readsAll(root, dataPath, reads)
  }
  return { own, root, reads: coll => descriptors.has(coll), complete }
}
