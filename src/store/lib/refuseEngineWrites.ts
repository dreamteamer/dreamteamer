import type { Descriptor } from "../../types.ts"
import type { Store } from "../Store.ts"

export function refuseEngineWrites(store: Store, d: Descriptor, changed: Iterable<string>): void {
  const fields = d.compiled?.fields
  if (!fields) return
  for (const key of changed) {
    const f = fields[key]
    if (f?.derived)
      throw new Error(
        `${key} is written by the engine${key === "created" ? " (stamped when the record is added)" : ""} — nothing was written.`
      )
    if (f?.virtual)
      throw new Error(`${key} is not stored — it is computed when the record is read — nothing was written.`)
  }
}
