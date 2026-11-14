/** One subject for one repo's rows. The git status letter IS the verb, which is why a
 *  single-record commit keeps exactly the subject it had when writes committed themselves. */
export function composeSubject(rows: { verb: string; collection: string; id: string }[]): string {
  if (rows.length === 1) return `dreamteamer: ${rows[0].collection} ${rows[0].verb} ${rows[0].id}`
  const collections = [...new Set(rows.map(r => r.collection))].sort()
  if (collections.length === 1) {
    const counts: Record<string, number> = {}
    for (const r of rows) counts[r.verb] = (counts[r.verb] ?? 0) + 1
    const parts = Object.entries(counts)
      .map(([v, n]) => `${n} ${v}`)
      .join(", ")
    return `dreamteamer: ${collections[0]} ${rows.length} changes (${parts})`
  }
  return `dreamteamer: ${rows.length} changes across ${collections.join(", ")}`
}
