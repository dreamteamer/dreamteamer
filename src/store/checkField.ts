import type { Field } from "../types/Field.ts"
import type { Model } from "../types/Model.ts"
import { checkValue } from "./checkValue.ts"

/** what is wrong with a field's value, each message led by `at`, the field's name */
export function checkField(model: Model, f: Field, v: unknown, at: string, unresolved?: Map<string, number>): string[] {
  const out: string[] = []
  if (v === null || v === undefined || f.mirror_of) return out
  const nested = f.type === "object" || f.type === "map"
  if (!f.many && !nested && Array.isArray(v) && v.length !== 1) {
    out.push(`${at}: holds a list but the field is not many`)
    return out
  }
  const values: unknown[] = Array.isArray(v) && !(nested && !f.many) ? v : [v]
  for (const one of values) {
    const m = checkValue(model, f, one, unresolved)
    if (m) out.push(`${at}: ${m}`)
  }
  return out
}
