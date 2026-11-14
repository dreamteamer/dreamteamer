import path from "node:path"
import { parentFolders } from "../record/parentFolders.ts"
import { symlinkBelow } from "../record/symlinkBelow.ts"
import type { Under } from "../record/types.ts"

/** The child roots under `parentDir` that are symlinks (or sit behind one), for `check` to report. */
export function symlinkedChildRoots(under: Under, parentDir: string): string[] {
  const out: string[] = []
  for (const [, folder] of parentFolders(parentDir)) {
    const link = symlinkBelow(parentDir, path.join(folder, under.subfolder))
    if (link) out.push(link)
  }
  return out
}
