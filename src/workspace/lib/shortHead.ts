import { execFileSync } from "node:child_process"
import { QUIET } from "../../lib/consts.ts"

export const shortHead = (root: string): string | null => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, stdio: QUIET }).toString().trim()
  } catch {
    return null
  }
}
