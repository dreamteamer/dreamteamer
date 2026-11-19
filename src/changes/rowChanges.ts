import { layerOf } from "./layerOf.ts"
import { pathToRecord } from "../record/pathToRecord.ts"
import type { RecordChange, Row } from "./types.ts"
import type { Descriptors } from "../types.ts"

/**
 * One sampled repo's rows (the sampler above: `dt commit`, `dt status`) as report changes. A staged
 * rename is two records — the id IS the path — so the old id is read back off the old path.
 */
export function rowChanges(descriptors: Descriptors, repo: string, rows: Row[]): RecordChange[] {
  const prefix = repo === "." ? "" : `${repo}/`
  const layer = layerOf(descriptors, repo)
  const of = (rec: { collection: string; id: string }, rel: string, change: RecordChange["change"]): RecordChange => ({
    collection: rec.collection,
    id: rec.id,
    ref: `${rec.collection}/${rec.id}`,
    path: prefix + rel,
    repo,
    layer,
    change,
  })
  const out: RecordChange[] = []
  for (const r of rows) {
    out.push(
      of(r, r.repoRel, r.verb === "add" || r.verb === "rename" ? "created" : r.verb === "rm" ? "deleted" : "updated")
    )
    const old = r.verb === "rename" && r.fromRel ? pathToRecord(descriptors, prefix + r.fromRel) : null
    if (old) out.push(of(old, r.fromRel, "deleted"))
  }
  return out
}
