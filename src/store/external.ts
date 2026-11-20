import type { Store } from "./Store.ts"

export function external(
  store: Store,
  collection: string,
  id: string
): { label: string; from?: string; manifest: string } | null {
  if (store.ids(collection).has(id)) return null
  const v = store.vouched(collection, id)
  if (!v || v.seen) return null
  return { label: v.label, ...(v.from ? { from: v.from } : {}), manifest: v.manifest }
}
