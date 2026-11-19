import { parseRef } from "../record/parseRef.ts"
import type { Store } from "./Store.ts"

export function external(
  store: Store,
  collection: string,
  id: string,
  { referrer }: { referrer?: string } = {}
): { label: string; from?: string; manifest: string } | null {
  if (store.ids(collection).has(id)) return null
  let repo: string | null = null
  if (referrer) {
    const r = parseRef(referrer, store.namespaces)
    const rd = r && store.descriptors.get(r.collection)
    const f = rd && store.ids(r.collection).get(r.id)
    if (!f) throw new Error(`${referrer}: no such record here — a referrer is a record this workspace reads`)
    repo = store.layerOfFile(rd, f)?.layer ?? null
  }
  const v = store.vouched(collection, id, repo)
  if (!v || v.seen) return null
  return { label: v.label, ...(v.from ? { from: v.from } : {}), manifest: v.manifest }
}
