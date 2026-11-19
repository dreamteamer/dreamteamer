/**
 * Assign `a.b.c` into a nested object, creating plain objects on the way down.
 *
 * An empty or null value REMOVES the key rather than writing `''` — the same convention
 * `store.set` has always used for top-level fields (`if (v === null || v === '') delete next[k]`),
 * extended to the nested paths the meta verbs address. Without it there was no way to take a key
 * back out of a `ui-view`'s `options`, so a superseded option lingered as `provider: ''` and the
 * only cure was `rm` + `add`.
 *
 * Intermediate objects are not created on the way to a delete: unsetting `a.b` on a record with no
 * `a` should leave the record alone, not grow an empty `a: {}`.
 *
 * `explicit` is the escape hatch, and it has exactly one caller: a value the operator QUOTED
 * (`display.list.sort='""'`) is a value, empty or not. Without it the convention above has no exception
 * and `sort: ''` — which the surface needs to mean "unsorted" — is unwritable from the CLI.
 */
export function assignPath(target: Record<string, unknown>, dotted: string, value: unknown, explicit = false): void {
  const keys = dotted.split(".")
  const leaf = keys[keys.length - 1]
  const unset = !explicit && (value === null || value === "")
  let node = target
  for (const k of keys.slice(0, -1)) {
    if (node[k] == null || typeof node[k] !== "object" || Array.isArray(node[k])) {
      if (unset) return
      node[k] = {}
    }
    node = node[k] as Record<string, unknown>
  }
  if (unset) delete node[leaf]
  else node[leaf] = value
}
