import { execFileSync } from "node:child_process"
import { DtError } from "../lib/DtError.ts"

/**
 * Run git in a workspace and return what it printed. The engine's one way to git: the released API's history,
 * revert and commit need it, so an adapter for them runs it, explicitly, with each path after `--`.
 */
export function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 }).toString()
}

/** a revision a caller names: HEAD or a commit id of 4 to 40 hex digits, never something git could read as an option */
export function commitArg(rev: unknown): string {
  if (typeof rev !== "string" || !/^(?:HEAD|[0-9a-fA-F]{4,40})$/.test(rev))
    throw new DtError(`${JSON.stringify(rev)} is not a commit id — give a commit hash (4 to 40 hex digits) or HEAD`)
  return rev
}
