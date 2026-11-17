import { parseDocument } from "yaml"
import { isObject } from "../lib/isObject.ts"

/** a JSON replacer that writes a map's keys in sorted order, so that equal maps print alike */
function sorted(_k: string, v: unknown) {
  return isObject(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v
}

/** does this YAML text hold exactly these fields? Nothing is written that would not read back as what was meant. */
export function holds(yaml: string, fields: Record<string, unknown>): boolean {
  const doc = parseDocument(yaml)
  if (doc.errors.length) return false
  try {
    const js: unknown = doc.toJS()
    return JSON.stringify(js ?? {}, sorted) === JSON.stringify(fields, sorted)
  } catch {
    return false
  }
}
