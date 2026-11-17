import { commandsFor as evaluate } from "../store/commandsFor.ts"
import { parseRef } from "./parseRef.ts"
import type { Store } from "./Store.ts"

/** a memoised reader of the record a reference names, its id included; null when it does not resolve */
export function recordResolver(store: Store) {
  const memo = new Map<string, Record<string, unknown> | null>()
  return (ref: string) => {
    if (memo.has(ref)) return memo.get(ref) ?? null
    let target: Record<string, unknown> | null = null
    const at = parseRef(ref, store.namespaces)
    if (at)
      try {
        target = Object.assign({}, store.read(at.collection, at.id).fields, { id: at.id })
      } catch {
        // a dangling reference or an unknown collection narrows a filter, never widens it
      }
    memo.set(ref, target)
    return target
  }
}

/** every command bound to a collection and each id's state in it: the engine's evaluation, behind the API's Store */
export function commandsFor(store: Store, collection: string, ids: string[] = []) {
  store.descriptor(collection)
  return evaluate(store.model, collection, ids)
}
