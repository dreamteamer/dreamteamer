import path from "node:path"
import fs from "node:fs"
import { storageOf } from "./storageOf.ts"
import type { ContextRoot, ExportsContext } from "./types.ts"
import { walk } from "./walk.ts"
import type { exportsFacts } from "../runtime/exportsFacts.ts"
import type { Descriptors, Storage } from "../types.ts"

type LayerFact = NonNullable<ReturnType<typeof exportsFacts>["layers"]>[number]

/** Is every file under `dataDir` inside one of the `reads` folders (paths relative to `root`)? Judged on
 *  the disk NOW, so a folder a pull added after compile makes the repo incomplete without a recompile. */
function readsAll(root: string, dataDir: string, reads: string[]): boolean {
  const abs = path.join(root, dataDir)
  if (!fs.existsSync(abs)) return true
  const prefixes = reads.map(r => path.join(root, r) + path.sep)
  for (const f of walk(abs)) if (!prefixes.some(p => f.startsWith(p))) return false
  return true
}

/**
 * The one context every judgement uses. `layers` are the runtime's layer facts (null: an older runtime —
 * nothing is known, so no layer is complete and no layer holder is seen); `own` this workspace's package
 * name. A repo is named by its layer name, the write root by null.
 */
export function exportsContext({
  root,
  descriptors,
  own,
  layers,
  dataPath = "data",
}: {
  root: string
  descriptors: Descriptors
  own: string | null
  layers: LayerFact[] | null
  dataPath?: string
}): ExportsContext {
  const facts = new Map<string, LayerFact>((layers ?? []).map(l => [l.name, l]))
  const rootsOf = (coll: string): ContextRoot[] => {
    const d = descriptors.get(coll)
    if (!d) return []
    return storageOf(d).roots.map(r => {
      const fact = r.layer ? facts.get(r.layer) : null
      return {
        layer: r.layer ?? null,
        package: r.layer ? (fact?.package ?? null) : own,
        present: !r.layer || (!!fact && fs.existsSync(path.join(root, r.repo))),
      }
    })
  }
  const complete = (layer: string | null): boolean => {
    if (layer) {
      const l = facts.get(layer)
      return !!l && !l.narrowed && readsAll(root, l.data, l.reads)
    }
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
  return {
    own,
    rootsOf,
    complete,
    packageOf: layer => (layer ? (facts.get(layer)?.package ?? null) : own),
    rootOf: layer => (layer ? path.join(root, facts.get(layer)?.root ?? path.join("git_modules", layer)) : root),
  }
}
