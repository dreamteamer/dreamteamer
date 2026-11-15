import type { Descriptor } from "../../types.ts"
import { fieldsOf } from "../../record/descriptor.ts"

/**
 * The remedy line for a refusal whose cause is a GENERATED MIRROR — `dreamteamer relations rebuild
 * <collection>`, the same repair `check`'s staleness message names, and for the same reason: a
 * mirror's value is derived state the engine wrote, not the caller's to edit.
 *
 * Without it, a legacy duplicate in a mirror array made an ORDINARY write to an unrelated field on
 * the same record fail with somebody else's bookkeeping and no way out:
 *
 *   dt set meetings/kickoff name="Kickoff 2"
 *   ✖ validation failed:
 *       field recordings: [...,...] must NOT have duplicate items (items ## 1 and 0 are identical)
 *     nothing was written.
 *
 * The generated mirror carries `uniqueItems`, so a duplicate in one is never a value this engine
 * produced — it arrived by hand, or from a workspace written before the keyword existed. Naming the
 * one command that repairs it is the difference between a wall and a step.
 */
export function mirrorRemedy(d: Descriptor, fieldNames: string[]): string {
  const mirrors = [...new Set(fieldNames)].filter(f => f && fieldsOf(d)[f]?.mirror_of !== undefined)
  if (!mirrors.length) return ""
  return `\n  ${mirrors.join(", ")}: a GENERATED mirror — its value is derived from the owning side, not yours to set. Repair it with: dreamteamer relations rebuild ${d.name}`
}
