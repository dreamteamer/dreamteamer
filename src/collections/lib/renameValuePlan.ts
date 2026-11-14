import { valueRenameWalk } from "./valueRenameWalk.ts"
import type { Store } from "../../record/Store.ts"
import { fieldsOf } from "../../record/descriptor.ts"
import { enumValues } from "../../record/fields.ts"
import type { Workspace } from "../../types.ts"

/** The checks a value rename is held to before anything is walked. */
function valueRenameTarget(store: Store, collection: string, field: string, from: string, to: unknown): void {
  const f = fieldsOf(store.descriptor(collection))[field]
  if (!f) throw new Error(`no field "${field}" on ${collection}`)
  const values = f.enum === undefined ? null : enumValues(f.enum)
  if (!values)
    throw new Error(
      `${collection}.${field} has no enum — rename-value renames one value of an enum; a free value is rewritten with dreamteamer set`
    )
  if (!values.includes(from))
    throw new Error(`"${from}" is not a value of ${collection}.${field} — its enum is ${values.join(", ")}`)
  if (to === undefined || to === true || to === "")
    throw new Error(`missing <new>: dreamteamer rename-value ${collection} ${field} ${from} <new>`)
  if (values.includes(to))
    throw new Error(
      `"${to}" is already a value of ${collection}.${field} — merging two values is a record edit, not a rename`
    )
}

export function renameValuePlan(
  ws: Workspace,
  store: Store,
  collection: string,
  field: string,
  from: string,
  to: string | true | undefined
) {
  valueRenameTarget(store, collection, field, from, to)
  const { positions, records } = valueRenameWalk(ws, store, collection, field, from, to as string)
  return {
    collection,
    field,
    from,
    to,
    positions,
    records: records.length,
    refs: 0,
    cleared: 0,
    descriptors: new Set(positions.map(p => p.rel)).size,
  }
}
