import type { ChangeKind, RecordChange } from "./types.ts"

/**
 * `before` (the committed half, oldest first) folded with `after` (the pending half) — one entry per
 * record per repo, `committed` true when no pending part is left. Inside one half a ref can appear
 * twice only as a MOVE (a relocate, a placed record re-parented: deleted at one path, created at
 * another), which is one update at the live path. Across the halves the net change wins: created
 * then deleted never existed at either end and is dropped; created then edited is still created;
 * deleted then re-created is an update. The SAME ref in two repos is two records.
 */
export function foldChanges<T extends RecordChange>(before: T[], after: T[]): (T & { committed: boolean })[] {
  const key = (c: T): string => `${c.repo}\0${c.ref}`
  const half = (list: T[]): Map<string, T> => {
    const m = new Map<string, T>()
    for (const c of list) {
      const had = m.get(key(c))
      m.set(key(c), had ? { ...(c.change === "deleted" ? had : c), change: "updated" } : c)
    }
    return m
  }
  const out = new Map<string, T & { committed: boolean }>()
  for (const [k, c] of half(before)) out.set(k, { ...c, committed: true })
  for (const [k, c] of half(after)) {
    const was = out.get(k)?.change
    const change: ChangeKind | null = !was
      ? c.change
      : was === "created"
        ? c.change === "deleted"
          ? null
          : "created"
        : was === "deleted" && c.change === "created"
          ? "updated"
          : c.change
    if (change) out.set(k, { ...c, change, committed: false })
    else out.delete(k)
  }
  const order = (c: T): string[] => [c.collection, c.id]
  return [...out.values()].sort((a, b) => {
    const [x, y] = [order(a), order(b)]
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
    return 0
  })
}
