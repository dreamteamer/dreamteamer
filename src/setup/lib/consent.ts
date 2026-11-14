import type { SetupAction } from "../../types.ts"
import type { PendingAction, SetupIO } from "../types.ts"

/** May this action run now? `ask(action)` is the y/n in a TTY; `allow` the --allow kinds. */
export async function consent(
  action: SetupAction | PendingAction,
  {
    allow = new Set(),
    tty = false,
    ask = null,
    authorize = false,
  }: { allow?: Set<string>; tty?: boolean; ask?: SetupIO["ask"] | null; authorize?: boolean } = {}
): Promise<boolean> {
  const kinds = [...new Set((action.effects ?? []).map(e => e.kind))]
  if (kinds.includes("account")) return authorize && tty
  const asked = kinds.filter(k => k !== "workspace-files")
  if (!asked.length) return true
  if (asked.every(k => allow.has(k))) return true
  if (tty && ask) return !!(await ask(action, asked))
  return false
}
