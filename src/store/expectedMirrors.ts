import type { Relation } from "../types/Relation.ts"

/** the references of a value, which may be one or a list */
export function refsOf(v: unknown): unknown[] {
  return v === null || v === undefined ? [] : Array.isArray(v) ? v : [v]
}

/** What each target record's reverse field should hold, from the owner records: a sorted list, or one reference when unique. */
export function expectedMirrors(r: Relation, owners: Map<string, Record<string, unknown>>) {
  const res = new Map<string, string | string[]>()
  for (const [id, data] of owners)
    for (const ref of refsOf(data[r.field])) {
      if (typeof ref !== "string" || !ref.startsWith(`${r.target}/`)) continue
      const tid = ref.slice(r.target.length + 1)
      const self = `${r.owner}/${id}`
      const was = res.get(tid)
      res.set(tid, r.unique ? self : [...new Set([...refsOf(was).map(String), self])].sort())
    }
  return res
}

/** whether a reverse field holds what it should; absent and empty read the same */
export function sameMirror(r: Relation, actual: unknown, expected: string | string[] | undefined) {
  if (r.unique) return (actual ?? null) === (expected ?? null)
  return JSON.stringify(refsOf(actual).map(String).sort()) === JSON.stringify(refsOf(expected))
}
