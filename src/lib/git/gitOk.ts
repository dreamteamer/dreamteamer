import { execFileSync } from "node:child_process"

/** Did `git <args>` in `root` exit 0? Output is discarded. */
export const gitOk = (root: string, args: string[]): boolean => {
  try {
    execFileSync("git", args, { cwd: root, stdio: "ignore" })
    return true
  } catch {
    return false
  }
}
