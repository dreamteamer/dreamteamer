import type { Descriptor } from "../../types.ts"
import { placementOf } from "../../record/placement.ts"
import path from "node:path"
import { storageOf } from "../../record/storageOf.ts"
import { execFileSync } from "node:child_process"
import { QUIET } from "../../lib/consts.ts"
import { pathToRecord } from "../../record/pathToRecord.ts"
import type { Store } from "../Store.ts"

export function pathAt(store: Store, d: Descriptor, id: string, hash: string): string | null {
  if (!placementOf(d)) return null
  const cwd = path.resolve(store.root, storageOf(d).repo)
  const dirs = store.recordDirs(d).map(p => path.relative(cwd, p))
  let out: string
  try {
    out = execFileSync("git", ["ls-tree", "-r", "--name-only", "--end-of-options", hash, "--", ...dirs], {
      cwd,
      stdio: QUIET,
    }).toString()
  } catch {
    return null
  }
  const prefix = storageOf(d).repo === "." ? "" : `${storageOf(d).repo}/`
  for (const p of out.split("\n").filter(Boolean)) {
    const rec = pathToRecord(store.descriptors, prefix + p)
    if (rec && rec.collection === d.name && rec.id === id) return p
  }
  return null
}
