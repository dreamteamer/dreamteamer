import { execFileSync } from "node:child_process"
import { QUIET } from "../consts.ts"

export function tryGit(cwd: string, args: string[], timeout = 30_000): string | null {
  try {
    return execFileSync("git", args, { cwd, stdio: QUIET, timeout }).toString().trim() || null
  } catch {
    return null
  }
}
