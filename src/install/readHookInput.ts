/**
 * What the harness said, as `{ cwd, name, raw }`. Exported through the public API because an
 * extension's own hook form (`worktree add --hook`) parses the same payload.
 *
 * ⚠ THE FIELD NAMES ARE THE HARNESS'S. Claude Code's hooks reference documents every event as
 * carrying `cwd`, and the two worktree events as additionally carrying `worktree_name` and
 * `worktree_path` — so `worktree_name` is the primary spelling here and a bare `name` is only the
 * fallback, not the other way round. `raw` is kept whole because a later verb reads a field these
 * three do not name (`land` wants `worktree_path`), and because the KEYS are the whole diagnostic
 * when a hook has been wired to the wrong event: a well-formed payload of the wrong shape is
 * indistinguishable from a broken one until you can see what it did carry.
 */
export function readHookInput(stdinText: string): {
  cwd: string | null
  name: string | null
  raw: Record<string, unknown>
} {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(stdinText)
  } catch {
    throw new Error("hook input is not JSON")
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("hook input is not JSON")
  const cwd = (raw.cwd ?? raw.worktree_path ?? null) as string | null
  const name = (raw.worktree_name ?? raw.name ?? null) as string | null
  if (!cwd && !name) {
    throw new Error(
      `hook input carries neither a cwd nor a worktree_name — keys received: ${Object.keys(raw).join(", ") || "(none)"}`
    )
  }
  return { cwd, name, raw }
}
