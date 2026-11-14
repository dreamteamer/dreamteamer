import type { UnitResult } from "./types.ts"

/** The unit lines a verb prints after setupAndCommit, one block per unit. */
export function printUnitResults(results: UnitResult[], ignored: string[], log: (line: string) => void): void {
  for (const text of ignored) log(`⚠ ${text} — ignored`)
  for (const r of results) {
    const verified = r.verified ? ` · verified ${r.verified}` : ""
    log(
      `${r.state === "ready" ? "✔" : r.state === "blocked" ? "✖" : "—"} ${r.id}: ${r.state}${verified}${r.detail ? ` — ${r.detail}` : ""}`
    )
    for (const a of r.applied) log(`    ✔ ${a.id}${a.message ? ` — ${a.message}` : ""}`)
    for (const f of r.failed) log(`    ✖ ${f.id} — ${f.message}`)
    for (const p of r.problems ?? []) log(`    ✖ ${p.id} — ${p.reason}`)
    for (const p of r.pending) log(`    … ${p.id} (${p.why})${p.reason ? ` — ${p.reason}` : ""}`)
    if (r.needs.length) log(`    needs input: ${r.needs.join(", ")} — dt setup ${r.id} --input ${r.needs[0]}=<value>`)
    if (ownerStepPending(r))
      log(
        `    the owner's step (opens a browser): dt setup ${r.id}${r.needs.map(n => ` --input ${n}=<value>`).join("")} --authorize`
      )
  }
}

/** Whether a unit still has a step only the owner runs — a sign-in, a consent — pending. */
const ownerStepPending = (r: Pick<UnitResult, "pending">): boolean =>
  (r.pending ?? []).some(p => p.runBy === "owner" || (p.effects ?? []).some(e => e.kind === "account"))
