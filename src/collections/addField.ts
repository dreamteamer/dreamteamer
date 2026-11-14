import { collectionSourceFile } from "./collectionSourceFile.ts"
import { mixinDeclaring } from "./mixinDeclaring.ts"
import { readYaml } from "./schema-ops.ts"
import { INJECTED } from "./consts.ts"
import { upsertField } from "./upsertField.ts"
import type { Store } from "../record/Store.ts"
import { fieldsOf } from "../record/descriptor.ts"
import type { Field, Workspace } from "../types.ts"

export function addField(
  ws: Workspace,
  store: Store,
  collection: string,
  { name: fieldName, field, moduleId }: { name: string | true | undefined; field: Field; moduleId?: string | null }
) {
  if (!fieldName || fieldName === true) throw new Error("missing --name <field>")
  if (INJECTED.has(fieldName))
    throw new Error(`"${fieldName}" is injected by the engine into every collection — pick another name`)
  const merged = fieldsOf(store.descriptor(collection))[fieldName]
  const target = collectionSourceFile(ws, store, collection, moduleId, {
    allowNew: true,
    subject: `${collection}.${fieldName}`,
  })
  // ⚠ On an OVERLAY, a field the base already declares is an OVERRIDE, not a duplicate — that is
  // what an overlay is for. Only a write to the base, or to an overlay that already declares it,
  // can collide.
  if (merged !== undefined) {
    const mixin = mixinDeclaring(ws, store, collection, fieldName)
    const inTarget = readYaml(target.file)?.fields?.[fieldName] !== undefined
    if (!target.overlay || inTarget || mixin) {
      throw new Error(
        `field "${fieldName}" already exists on ${collection}${mixin ? ` (from mixin "${mixin.id}")` : ""} — change it with dreamteamer set-field ${collection} --name ${fieldName} …`
      )
    }
  }
  return upsertField(ws, store, collection, fieldName, field, `add-field ${fieldName}`, target)
}
