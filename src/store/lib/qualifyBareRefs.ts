import type { Descriptor, Fields } from "../../types.ts"
import { fieldsOf, targetsOf } from "../../record/descriptor.ts"
import { parseRef } from "../../record/parseRef.ts"
import type { Store } from "../Store.ts"

export function qualifyBareRefs(store: Store, d: Descriptor, fields: Fields): void {
  for (const [key, f] of Object.entries(fieldsOf(d))) {
    const targets = targetsOf(f)
    if (!targets || targets === "*" || targets.length !== 1) continue
    const raw = fields[key]
    if (raw == null) continue
    const qualify = (v: unknown): unknown =>
      typeof v === "string" && v !== "" && !v.startsWith("@") && !parseRef(v, store.namespaces)
        ? `${targets[0]}/${v}`
        : v
    fields[key] = Array.isArray(raw) ? raw.map(qualify) : qualify(raw)
  }
}
