import { execFileSync } from "node:child_process"

export const defaultGit = (args: string[], cwd: string): string => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  } catch (e) {
    // ⚠ GIT'S REASON LEADS. execFileSync does append the child's stderr to its message, but
    // BEHIND `Command failed: git <argv>` — and every summary in this file reads
    // `message.split('\n')[0]` (describeCheckout's parenthetical, applyInstall's per-step ✖), so
    // the one line that survived was the command line and never the explanation. `dt rm` on a
    // LOCKED worktree led with the argv and mentioned the lock underneath it.
    const why = String(e.stderr ?? "")
      .trim()
      .split("\n")
      .filter(Boolean)
    if (why.length) e.message = [...why, `(git ${args.join(" ")})`].join("\n  ")
    throw e
  }
}
