import { Store } from "../../store/Store.ts"
import type { Field } from "../../types.ts"
import { targetsOf } from "../../record/descriptor.ts"

/** A mirror is only correct for records written AFTER it existed: the far side's records already
 *  carrying a value are counted here, with the repair, because `check` flags every one of them the
 *  moment the field lands. */
export function reportMirror(store: Store, collection: string, fieldName: string, field: Field): void {
  if (!field?.mirror_of) return
  const t = targetsOf(field)
  const target = Array.isArray(t) ? t[0] : null
  if (!target || !store.descriptors.has(target)) return
  console.log(`  mirror of ${target}.${field.mirror_of}  (generated, read-only)`)
  const n = [...store.readAll(target)].filter(r => r.fields[field.mirror_of] != null).length
  if (n)
    console.log(
      `  ${n} ${target} ${n === 1 ? "record carries" : "records carry"} values — run: dreamteamer relations rebuild ${collection}`
    )
}
