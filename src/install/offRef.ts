import fs from "node:fs"
import path from "node:path"
import { commitOf } from "./commitOf.ts"
import { isLink } from "./isLink.ts"
import { tryGit } from "../lib/git/tryGit.ts"

/** Is this clone somewhere other than its declared ref? A branch ref is met by being ON the branch —
 *  moving it forward is `dt update`'s job; a tag or a sha by HEAD being that commit. Answered from
 *  what the clone already knows, so a settled clone costs no fetch. A folder that is not itself a
 *  clone is never re-pointed: git would walk up and act on the workspace repo. */
export function offRef(dest: string, ref: string): boolean {
  if (isLink(dest) || !fs.existsSync(path.join(dest, ".git"))) return false // never judged, never moved, through a link
  if (tryGit(dest, ["symbolic-ref", "--quiet", "--short", "HEAD"]) === ref) return false
  const branch = ["refs/heads/", "refs/remotes/origin/"].some(p =>
    tryGit(dest, ["rev-parse", "--verify", "--quiet", p + ref])
  )
  return branch || !commitOf(dest, ref) || commitOf(dest, ref) !== commitOf(dest, "HEAD")
}
