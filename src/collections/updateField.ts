import { declaringSource } from "./lib/declaringSource.ts"
import { fieldFromFlags } from "../lib/fieldFromFlags.ts"
import { readYaml } from "../lib/schema-ops.ts"
import { upsertField } from "./lib/upsertField.ts"
import type { Store } from "../store/Store.ts"
import { fieldsOf } from "../record/descriptor.ts"
import type { Field, Flags, Workspace } from "../types.ts"

/** What an override in a NEW overlay starts from: the shape it overrides, so the overlay validates
 *  on its own — every other key is inherited from the base. */
const overrideSeed = (merged: Field): Field => ({ type: merged.type, ...(merged.many && { many: true }) })

/**
 * Change one field. `flags` is the flag vocabulary (`fieldFromFlags`), applied over the field as its
 * source declares it; `field` is a whole v2 field from a surface, which replaces it.
 */
export function updateField(
  ws: Workspace,
  store: Store,
  collection: string,
  fieldName: string,
  { flags = {}, field, moduleId }: { flags?: Flags; field?: Field; moduleId?: string } = {}
) {
  const target = declaringSource(ws, store, collection, fieldName, moduleId, "set-field")
  const authored = readYaml(target.file)?.fields?.[fieldName]
  const previous = authored ?? overrideSeed(fieldsOf(store.descriptor(collection))[fieldName])
  return upsertField(
    ws,
    store,
    collection,
    fieldName,
    field ?? fieldFromFlags(store, flags, previous),
    `set-field ${fieldName}`,
    target
  )
}
