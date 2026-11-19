import { fieldRenameWalk } from "./fieldRenameWalk.ts"
import type { Store } from "../../store/Store.ts"
import { fieldsOf } from "../../record/descriptor.ts"
import type { Workspace } from "../../types.ts"

export function renameFieldPlan(ws: Workspace, store: Store, collection: string, from: string, to?: string | true) {
  const d = store.descriptor(collection)
  if (!fieldsOf(d)[from]) throw new Error(`no field "${from}" on ${collection}`)
  const { positions, records } = fieldRenameWalk(
    ws,
    store,
    collection,
    from,
    typeof to === "string" ? to : `<new-name>`
  )
  return {
    collection,
    from,
    to,
    positions,
    records: records.length,
    refs: 0,
    cleared: 0,
    descriptors: new Set(positions.map(p => p.rel)).size,
  }
}
