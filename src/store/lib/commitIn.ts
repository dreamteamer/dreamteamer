import path from "node:path"
import { execFileSync } from "node:child_process"
import { QUIET } from "../../lib/consts.ts"
import type { Store } from "../Store.ts"
import type { Undo } from "../types.ts"

export function commitIn(store: Store, cwd: string, files: string[], subject: string, undo: Undo | null): void {
  const rel = files.map(f => path.relative(cwd, f))
  try {
    // QUIET, per the rule at the top of this file: a failure we CATCH must not also print git's
    // own error. These three were the exception — a caught `git add` failure dumped git's raw
    // multi-line advice ("Another git process seems to be running…") on top of the clean message
    // this function throws, so the user read the scary one and not the accurate one.
    execFileSync("git", ["add", "--all", "--", ...rel], { cwd, stdio: QUIET })
    execFileSync("git", ["commit", "--quiet", "-m", subject, "--", ...rel], { cwd, stdio: QUIET })
  } catch (e) {
    try {
      execFileSync("git", ["reset", "--quiet", "--", ...rel], { cwd, stdio: QUIET })
    } catch {
      /* nothing staged */
    }
    if (undo) {
      try {
        undo()
      } catch (u) {
        throw new Error(
          `git commit failed AND rollback failed (${u.message}) — inspect the working tree. original: ${e.message.split("\n")[0]}`,
          { cause: u }
        )
      }
    }
    throw new Error(
      `git commit failed — the write was rolled back, nothing was changed. (${e.message.split("\n")[0]})`,
      { cause: e }
    )
  } finally {
    // ⚠ WHETHER IT LANDED OR NOT. The failure path resets the index and undoes the write, but a
    // commit that threw may still have created one — and a HEAD memo naming the previous sha
    // would keep serving id maps from before it. See gitHead.
    store.headMoved()
  }
}
