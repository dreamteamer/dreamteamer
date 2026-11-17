import { asStrings } from "./asStrings.ts"

/** a list of text, where one text is a list of one; anything else is a DtError that says where it was found */
export function asNames(v: unknown, where: string): string[] {
  return typeof v === "string" ? [v] : asStrings(v, where)
}
