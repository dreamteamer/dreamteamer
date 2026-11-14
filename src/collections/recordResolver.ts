import type { Store } from "../record/Store.ts"
import { parseRef } from "../record/parseRef.ts"
import type { Fields } from "../types.ts"

// memoized `<collection>/<id>` → parsed fields (or null) for ONE evaluation pass:
// overlapping refs across a 50-record selection parse once, and filter.js stays
// pure — it never learns about the store, it just gets this callback.
export function recordResolver(store: Store): (ref: string) => Fields | null {
  const memo = new Map<string, Fields | null>()
  return ref => {
    if (memo.has(ref)) return memo.get(ref)
    let target = null
    // ⚠ `parseRef`, NEVER `ref.indexOf('/')`. This split at the first slash until 0.13.3, which
    // made `family/people/dana-levi` the collection `family` (a NAMESPACE, not a collection) holding
    // the id `people/dana-levi`. `store.read` threw, the catch below swallowed it, and the caller got
    // null — which filter.js is documented to treat as NARROWING. So every one-hop relational
    // filter over a namespaced collection matched ZERO records, with no error anywhere, while the
    // identical filter over a default-namespace ref worked. Measured on a real vault: 151 rows via
    // `companies/<id>`, 0 rows via `family/people/<id>`, 273 for the same records addressed flat.
    // The blast radius was not only filtering — this resolver also evaluates `available_when`/`done_when`
    // below, so a binding predicate hopping a namespaced ref reported "not available".
    const parsed = parseRef(ref, store.namespaces)
    if (parsed) {
      try {
        const { fields } = store.read(parsed.collection, parsed.id)
        target = { ...fields, id: parsed.id }
      } catch {
        /* dangling ref or unknown collection — narrows, never widens */
      }
    }
    memo.set(ref, target)
    return target
  }
}
