import { DtError } from "./DtError.ts"
import { kindOf } from "./kindOf.ts"

/** text, or a DtError that says where something else was found */
export function asString(v: unknown, where: string): string {
  if (typeof v !== "string") throw new DtError(`${where}: expected text, found ${kindOf(v)}`)
  return v
}
