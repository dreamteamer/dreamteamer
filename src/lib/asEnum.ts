import { DtError } from "./DtError.ts"
import { isObject } from "./isObject.ts"
import { kindOf } from "./kindOf.ts"

/**
 * An enum as a descriptor writes it: a list of values, or a map whose keys are the values and whose entries carry
 * how each is shown (`label`, `color`, `icon`, `description`). The map's entries are kept as written.
 */
export function asEnum(v: unknown, where: string) {
  if (Array.isArray(v)) {
    const res: { values: unknown[]; choices?: Record<string, unknown> } = { values: v }
    return res
  }
  if (!isObject(v)) throw new DtError(`${where}: expected a list or a map of values, found ${kindOf(v)}`)
  for (const [k, t] of Object.entries(v))
    if (t !== null && !isObject(t))
      throw new DtError(`${where}.${k}: expected a map of how the value is shown, found ${kindOf(t)}`)
  const res: { values: unknown[]; choices?: Record<string, unknown> } = { values: Object.keys(v), choices: v }
  return res
}
