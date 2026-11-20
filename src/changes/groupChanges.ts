import type { ChangeGroup, RecordChange } from "./types.ts"

/** One group per collection, in the order `foldChanges` sorted them. */
export function groupChanges<T extends RecordChange>(changes: T[]): ChangeGroup<T>[] {
  const groups = new Map<string, ChangeGroup<T>>()
  for (const c of changes) {
    const k = c.collection
    if (!groups.has(k))
      groups.set(k, {
        collection: c.collection,
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
