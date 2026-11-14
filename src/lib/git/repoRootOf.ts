import path from "node:path"
import fs from "node:fs"
import { toPosix } from "../../compile/compile.ts"

/** The git repo that will hold a module's records: nearest `.git` at or above the module root,
 *  as a workspace-relative path (`.` = the workspace itself). `.git` may be a FILE — worktrees
 *  and submodules write a pointer file rather than a directory — so existsSync, not isDirectory. */
export function repoRootOf(moduleRoot: string, wsRoot: string): string {
  const stop = path.resolve(wsRoot)
  let dir = path.resolve(moduleRoot)
  while (dir.startsWith(stop)) {
    if (fs.existsSync(path.join(dir, ".git"))) return toPosix(path.relative(stop, dir)) || "."
    if (dir === stop) break
    dir = path.dirname(dir)
  }
  return "."
}
