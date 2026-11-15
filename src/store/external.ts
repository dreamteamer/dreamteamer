import { parseRef } from "../record/parseRef.ts"
import { exportsFacts } from "../runtime/exportsFacts.ts"
import { exportsContext } from "../record/exportsContext.ts"
import { readExports } from "../record/readExports.ts"
import { sees } from "../record/sees.ts"
import path from "node:path"
import { EXPORTS_FILE } from "../record/consts.ts"
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
  const facts = exportsFacts(store.root)
  const ctx = exportsContext({
    root: store.root,
    descriptors: store.descriptors,
    own: facts.own,
    layers: facts.layers,
    dataPath: facts.data,
  })
  const e = readExports(ctx.rootOf(repo))?.[collection]?.[id]
  if (!e || sees(e, collection, ctx)) return null
  return {
    label: e.label,
    ...(e.from ? { from: e.from } : {}),
    manifest: path.relative(store.root, path.join(ctx.rootOf(repo), EXPORTS_FILE)),
  }
}
