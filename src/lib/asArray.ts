import { DtError } from "./DtError.ts"
import { kindOf } from "./kindOf.ts"

/** a list whose every item passes `read`, or a DtError that says where something else was found */
export function asArray<T>(v: unknown, where: string, read: (x: unknown, where: string) => T): T[] {
  if (!Array.isArray(v)) throw new DtError(`${where}: expected a list, found ${kindOf(v)}`)
  return v.map((t, i) => read(t, `${where}[${i}]`))
}
