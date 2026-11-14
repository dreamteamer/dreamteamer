import type { SetupCheck } from "../types.ts"
import { CHECK_STATUSES } from "./setup-contract.ts"
import type { Folded } from "./types.ts"

/** One line from a unit's checks — the design's status table, in its order. */
export function fold(checks: SetupCheck[], { skipped = false }: { skipped?: boolean } = {}): Folded {
  if (skipped) return { state: "skipped", detail: "dt setup <unit> to resume", verified: null }
  if (!checks.length)
    return { state: "no-evidence", detail: "inspect returned no checks — never ready", verified: null }
  const unknown = checks.filter(c => !(CHECK_STATUSES as string[]).includes(c.status))
  if (unknown.length)
    return {
      state: "blocked",
      detail: unknown.map(c => `${c.title ?? c.id}: unknown status ${JSON.stringify(c.status)}`).join(" · "),
      verified: null,
    }
  const blocked = checks.filter(c => c.status === "blocked")
  if (blocked.length)
    return {
      state: "blocked",
      detail: blocked.map(c => `${c.title ?? c.id}${c.detail ? ` — ${c.detail}` : ""}`).join(" · "),
      verified: null,
    }
  const open = checks.filter(c => c.status === "missing" || c.status === "unverified")
  if (open.length)
    return { state: "configured", detail: open.map(c => `${c.title ?? c.id} ${c.status}`).join(" · "), verified: null }
  const dates = checks
    .map(c => c.evidence?.at)
    .filter(d => typeof d === "string")
    .sort()
  return { state: "ready", detail: "", verified: dates.at(-1) ?? null }
}
