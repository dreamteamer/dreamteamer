import { execFileSync } from "node:child_process"

/** Does git know this path? A deleted-and-never-committed file must be dropped from a pathspec. */
export function isTracked(root: string, rel: string): boolean {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", rel], {
      cwd: root,
      stdio: ["ignore", "ignore", "ignore"],
    })
    return true
  } catch {
    return false
  }
}
