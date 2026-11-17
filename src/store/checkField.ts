import { isObject } from "../lib/isObject.ts"
import type { Field } from "../types/Field.ts"
import type { Model } from "../types/Model.ts"
import { checkValue } from "./checkValue.ts"

/**
 * What is wrong with a field's value, each message led by `at`, the field's path: `address.zip`, `steps[1].stop`.
 * An object's fields are checked as a record's are, and any key it does not declare is let through, as the released
 * engine lets it through. A map's values are checked against `values`; inside a map a reference is only text, since
 * the released engine neither resolves nor counts it (`plain`). A null is checked as the empty value of its type, as
 * the released engine's validator converts it: empty text, 0 or false, and never a map.
 */
export function checkField(
  model: Model,
  f: Field,
  v: unknown,
  at: string,
  unresolved?: Map<string, number>,
  plain = false,
): string[] {
  const out: string[] = []
  if (v === undefined || f.mirror_of) return out
  const nested = f.type === "object" || f.type === "map"
  if (!f.many && Array.isArray(v) && (nested || v.length !== 1)) {
    out.push(`${at}: ${nested ? "expected a map" : "holds a list but the field is not many"}`)
    return out
  }
  // a single value stands for a list of one, except a map, which is never read as a list
  if (f.many && nested && !Array.isArray(v)) {
    out.push(`${at}: expected a list of maps`)
    return out
  }
  const values: unknown[] = Array.isArray(v) ? v : [v]
  values.forEach((one, i) => {
    if (!nested) {
      const m = checkValue(model, f, one, unresolved, plain)
      if (m) out.push(`${at}: ${m}`)
      return
    }
    const p = f.many ? `${at}[${i}]` : at
    if (!isObject(one)) out.push(`${p}: expected a map`)
    else if (f.type === "map") {
      if (f.values)
        for (const [k, t] of Object.entries(one))
          out.push(...checkField(model, f.values, t, `${p}.${k}`, unresolved, true))
    } else
      for (const [k, s] of Object.entries(f.fields ?? {}))
        if (one[k] !== undefined) out.push(...checkField(model, s, one[k], `${p}.${k}`, unresolved, plain))
        else if (s.required && s.default === undefined) out.push(`${p}.${k}: required`)
  })
  return out
}
