import { asTree } from "../../lib/schema-ops.ts"
import type { At } from "./types.ts"

// The value half of rule 6: an enum value is named by the field's `enum` (a list, or the key of a
// decorated map), its `default`, a constraint's `const`/`enum` on that field, a view filter and a
// binding condition on it, and every record holding it.

/** Rewrite the value inside one field's subschema of a constraint. */
export function renameValueInSubschema(sub: unknown, from: string, to: string, at: At, label: string): void {
  const s = asTree(sub)
  if (!s) return
  if (s.const === from) {
    s.const = to
    at(`${label}.const`)
  }
  if (Array.isArray(s.enum) && s.enum.includes(from)) {
    s.enum = s.enum.map(v => (v === from ? to : v))
    at(`${label}.enum`)
  }
  for (const k of ["items", "contains", "not", "if", "then", "else"])
    renameValueInSubschema(s[k], from, to, at, `${label}.${k}`)
  for (const k of ["allOf", "anyOf", "oneOf"]) {
    const subs = s[k]
    ;(Array.isArray(subs) ? subs : []).forEach((x: unknown, i: number) =>
      renameValueInSubschema(x, from, to, at, `${label}.${k}[${i}]`)
    )
  }
}
