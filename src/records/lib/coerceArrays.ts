import type { Descriptor, Flags, Fields } from "../../types.ts"
import { fieldsOf } from "../../record/descriptor.ts"

/** CLI values are strings; split comma-lists for array-typed fields (ajv coerces the rest) */
export function coerceArrays(d: Descriptor, fields: Flags): Fields {
  const out: Fields = {}
  for (const [k, v] of Object.entries(fields)) {
    const isList = fieldsOf(d)[k]?.many === true
    // An array here means the operator SPELLED the key twice (`--tags a --tags b`, or
    // `tags=a tags=b`). On a list field each sighting is one element — deliberately NOT
    // comma-split again, so a value that contains a comma can be written by repeating the flag.
    if (Array.isArray(v)) {
      if (!isList) {
        throw new Error(
          `${k} was given ${v.length} times (--${k} <value> / ${k}=<value>) and ${k} is not an array field — pass it once`
        )
      }
      out[k] = v
      continue
    }
    out[k] =
      isList && typeof v === "string"
        ? v
            .split(",")
            .map(s => s.trim())
            .filter(Boolean)
        : v
  }
  return out
}
