import type { Under } from "./types.ts"
import type { Fields } from "../types.ts"

/**
 * The parent id a record's owner field names, or null when the field is empty. `parseRef` is passed
 * in (bound to the workspace's namespaces) so this stays pure. A value that parses to some OTHER
 * collection is not an owner either — the reference check reports it; placement does not guess.
 */
export function ownerIdOf(
  fields: Fields | null | undefined,
  under: Under,
  parseRef: (ref: string) => { collection: string; id: string } | null
): string | null {
  const v = fields?.[under.parent]
  if (typeof v !== "string" || v === "") return null
  const p = parseRef(v)
  return p && p.collection === under.collection ? p.id : null
}
