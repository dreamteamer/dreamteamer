import type { Field } from "../../types.ts"

/**
 * The `fields` map with `name` set. A NEW field lands before the body field, because field order is
 * form order and a record's prose belongs last; an EXISTING one keeps its place, because `set-field`
 * must not reorder a descriptor its author ordered by hand.
 */
export function placeField(fields: Record<string, Field>, name: string, field: Field): Record<string, Field> {
  if (fields[name] !== undefined) return { ...fields, [name]: field }
  const body = Object.keys(fields).find(k => fields[k]?.body === true)
  if (body === undefined) return { ...fields, [name]: field }
  const out: Record<string, Field> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (k === body) out[name] = field
    out[k] = v
  }
  return out
}
