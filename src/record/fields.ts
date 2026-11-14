import { SCALAR_TYPES } from "./SCALAR_TYPES.ts"

/** Is `type` a reference to one or more collections, given the names that exist? */
export function referenceTargets(type: unknown, collections: Set<string>): string[] | null {
  if (type === "reference") return ["*"]
  if (Array.isArray(type)) return type
  if (typeof type === "string" && !SCALAR_TYPES.includes(type) && collections.has(type)) return [type]
  return null
}

/** The enum's value list, from a list or a map; null when it is neither. */
export function enumValues(e: unknown): unknown[] | null {
  if (Array.isArray(e)) return e
  if (e && typeof e === "object") return Object.keys(e)
  return null
}

/** The default field label — the same rule compile's titleCase has always applied, so a surface
 *  draws a v2 field exactly as it drew the v1 one. */
export function fieldTitleOf(name: unknown): string {
  return String(name)
    .split(/[_\-\s/]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
}
