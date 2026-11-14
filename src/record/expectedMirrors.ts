import type { Relation } from "./types.ts"
import type { Fields } from "../types.ts"

/** What each target record's mirror SHOULD hold, computed from the owning side.
 *  Sorted arrays (ids are usually date-prefixed, so that reads chronological); a scalar for unique. */
export function expectedMirrors(
  rel: Relation,
  ownerRecords: Iterable<{ id: string; fields?: Fields }>
): Map<string, string | string[]> {
  const exp = new Map<string, string | string[]>()
  for (const { id, fields } of ownerRecords) {
    const raw = fields?.[rel.field]
    const refs = raw == null ? [] : Array.isArray(raw) ? raw : [raw]
    for (const ref of refs) {
      if (typeof ref !== "string" || !ref.startsWith(`${rel.target}/`)) continue
      const targetId = ref.slice(rel.target.length + 1)
      const self = `${rel.owner}/${id}`
      if (rel.unique) exp.set(targetId, self)
      // DEDUPED, like the set the store writes (store.js applyMirrorEdits) — an owner may name
      // one target twice (an authored reference array declares no uniqueItems, so `dt add x
      // --meetings m1,m1` is accepted). Appending blind made this the ONE expectation nothing
      // else agreed with: check called the store's correct mirror stale, and the repair its
      // message names — `relations rebuild` — wrote the duplicate it was run to remove.
      else exp.set(targetId, [...new Set([...((exp.get(targetId) as string[] | undefined) ?? []), self])].sort())
    }
  }
  return exp
}
