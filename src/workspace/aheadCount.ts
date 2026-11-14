import { execFileSync } from "node:child_process"
import { GIT_QUIET } from "./consts.ts"

/** How many commits this repo has that its upstream does not. Falls back to "not on any remote",
 *  because a fresh `dt install --clone` has no upstream configured and "ahead of nothing" is not a
 *  number the report can print. */
export function aheadCount(root: string): number | null {
  try {
    const n = execFileSync("git", ["rev-list", "--count", "@{upstream}..HEAD"], { cwd: root, stdio: GIT_QUIET })
      .toString()
      .trim()
    return Number(n)
  } catch {
    try {
      const n = execFileSync("git", ["rev-list", "--count", "HEAD", "--not", "--remotes"], {
        cwd: root,
        stdio: GIT_QUIET,
      })
        .toString()
        .trim()
      return Number(n) || 1
    } catch {
      return 1
    }
  }
}
