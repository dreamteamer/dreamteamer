import type { ChangeGroup, RecordChange } from "./types.ts"

/**
 * One group per collection AND layer, in the order `foldChanges` sorted them: a collection changed
 * both here and in a layer is two entries, so the line never hides which repo a write landed in.
 */
export function groupChanges<T extends RecordChange>(changes: T[]): ChangeGroup<T>[] {
  const groups = new Map<string, ChangeGroup<T>>()
  for (const c of changes) {
    const k = `${c.collection}\0${c.layer ?? ""}`
    if (!groups.has(k))
      groups.set(k, {
        collection: c.collection,
        layer: c.layer ?? null,
        created: 0,
        updated: 0,
        deleted: 0,
        records: [],
      })
    const g = groups.get(k)
    g[c.change]++
    g.records.push(c)
  }
  return [...groups.values()]
}
