import { asArray } from "./asArray.ts"
import { asString } from "./asString.ts"

/** a list of text, or a DtError that says where something else was found */
export function asStrings(v: unknown, where: string): string[] {
  return asArray(v, where, asString)
}
