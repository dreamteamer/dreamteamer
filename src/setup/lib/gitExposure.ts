import { spawnSync } from "node:child_process"

/** read-only git, scoped to the root: no optional locks, no fsmonitor, no GIT_* from the environment */
const GIT_ENV_KEYS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "SystemRoot",
  "SYSTEMROOT",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "XDG_CONFIG_HOME",
]

function git(root: string, args: string[]): { status: number | null; stderr: string } {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" }
  for (const k of GIT_ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k]
  const r = spawnSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", root, ...args], {
    env,
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  })
  return { status: r.error ? null : r.status, stderr: r.stderr ?? "" }
}

/**
 * Could workspace-relative `rel` end up in a commit? `{ safe }` or `{ safe: false, reason }`: in a
 * repository git decides (not tracked, and ignored); outside any repository nothing can be committed.
 */
export function gitExposure(root: string, rel: string): { safe: boolean; reason?: string } {
  const top = git(root, ["rev-parse", "--show-toplevel"])
  if (top.status !== 0) {
    if (top.status === 128 && /not a git repository/i.test(top.stderr)) return { safe: true }
    if (top.status === null) return { safe: true } // no git on this machine: nothing commits
    return { safe: false, reason: `git could not inspect this workspace — nothing was written` }
  }
  if (git(root, ["ls-files", "--error-unmatch", "--", rel]).status === 0)
    return {
      safe: false,
      reason: `${rel} is tracked by git, so its contents would be committed — untrack it (git rm --cached ${rel}) and ignore it first`,
    }
  if (git(root, ["check-ignore", "-q", "--", rel]).status === 0) return { safe: true }
  return { safe: false, reason: `git would commit ${rel} — add it to .gitignore first` }
}
