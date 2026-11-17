import type { commitPending } from "../api/commitPending.ts"

const KINDS = ["created", "updated", "deleted"] as const

/** what `commitPending` names, one row per record as the released engine reports it, by collection and id */
export function changesOf(results: ReturnType<typeof commitPending>) {
  const rows = results.flatMap((r) =>
    r.rows.map((t) => {
      const res = {
        change: t.verb === "rm" ? KINDS[2] : t.verb === "set" ? KINDS[1] : KINDS[0],
        collection: t.collection,
        id: t.id,
        ref: `${t.collection}/${t.id}`,
        path: t.repoRel,
        committed: r.sha !== null,
        sha: r.sha,
      }
      return res
    }),
  )
  return rows.sort((x, y) => ((x.collection === y.collection ? x.id < y.id : x.collection < y.collection) ? -1 : 1))
}

/** the released engine's record report: the line a reply ends with, then the first 20 records */
export function printChanges(out: (v: unknown) => void, rows: ReturnType<typeof changesOf>) {
  const groups = new Map<string, Record<(typeof KINDS)[number], number>>()
  for (const t of rows) {
    const g = groups.get(t.collection) ?? { created: 0, updated: 0, deleted: 0 }
    g[t.change]++
    groups.set(t.collection, g)
  }
  const counts = (g: Record<string, number>) =>
    KINDS.filter((t) => g[t])
      .map((t) => `${g[t]} ${t}`)
      .join(", ")
  out(`records — ${[...groups].map(([c, g]) => `${c}: ${counts(g)}`).join(" · ")}`)
  for (const t of rows.slice(0, 20))
    out(`  ${t.change.padEnd(7)}  ${t.ref}  ${t.path}  · ${t.sha ? `committed ${t.sha}` : "uncommitted"}`)
  if (rows.length > 20) out(`  + ${rows.length - 20} more — --json lists every record`)
}
