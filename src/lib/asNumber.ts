import { DtError } from "./DtError.ts"
import { kindOf } from "./kindOf.ts"

/** a number, or a DtError that says where something else was found */
export function asNumber(v: unknown, where: string): number {
  if (typeof v !== "number") throw new DtError(`${where}: expected a number, found ${kindOf(v)}`)
  return v
}
