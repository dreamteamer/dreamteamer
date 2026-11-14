import { execFileSync } from "node:child_process"
import { GIT_QUIET } from "./consts.ts"

export const shortHead = (root: string): string | null => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, stdio: GIT_QUIET }).toString().trim()
  } catch {
    return null
  }
}
