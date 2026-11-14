import type { Store } from "../record/Store.ts"
import type { ModuleFields, ModuleRecordRow } from "./types.ts"

/** Every module as `{ id, fields }`, off the compiled projection — the one enumeration, so `--module`
 *  validation, the "known:" list and the id→package-name map cannot disagree. */
export function moduleRows(store: Store): ModuleRecordRow[] {
  if (!store.descriptors.has("modules")) return []
  return [...store.readAll("modules")].map(r => ({ id: r.id, fields: r.fields as ModuleFields }))
}
