import { execFileSync } from "node:child_process"
import { QUIET } from "../lib/consts.ts"
import path from "node:path"
import type { Store } from "./Store.ts"

export function writeLockPath(store: Store) {
  if (store._lockPath) return store._lockPath
  let dir = null
  try {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: store.root, stdio: QUIET })
      .toString()
      .trim()
    if (common) dir = path.resolve(store.root, common)
  } catch {
    /* not a git repo — fall back to the runtime folder */
  }
  store._lockPath = path.join(dir ?? store.runtime, ".dreamteamer-write-lock")
  return store._lockPath
}
