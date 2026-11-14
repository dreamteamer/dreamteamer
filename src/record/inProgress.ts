import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { QUIET } from "./consts.ts"

/** In-progress merge/rebase/cherry-pick makes a commit's meaning ambiguous. Ordinary dirtiness
 *  is NOT a refusal condition — committing dirty records is this verb's entire job. */
export function inProgress(cwd: string): string | null {
  let gitDir
  try {
    gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd, stdio: QUIET }).toString().trim()
  } catch {
    return "not a git repository"
  }
  for (const [marker, label] of [
    ["MERGE_HEAD", "merge"],
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
  ]) {
    if (fs.existsSync(path.join(gitDir, marker))) return `a ${label} is in progress`
  }
  return null
}
