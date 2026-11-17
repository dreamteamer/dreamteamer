import { DtError } from "./DtError.ts"
import { isObject } from "./isObject.ts"
import { kindOf } from "./kindOf.ts"

/** a map of names to values, or a DtError that says where something else was found */
export function asObject(v: unknown, where: string): Record<string, unknown> {
  if (!isObject(v)) throw new DtError(`${where}: expected a map of names to values, found ${kindOf(v)}`)
  return v
}
