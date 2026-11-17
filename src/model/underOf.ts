import { asObject } from "../lib/asObject.ts"
import { asString } from "../lib/asString.ts"
import { DtError } from "../lib/DtError.ts"
import type { Collection } from "../types/Collection.ts"

/**
 * Where the records of a collection stored under their owners (`storage.under`) go: inside the folder of the record
 * their `parent` field names, at `subfolder` there. Refused where the released compile refuses it.
 */
export function underOf(c: Collection, all: Record<string, Collection>): NonNullable<Collection["under"]> {
  const u = asObject(c.storage.under, "storage.under")
  const parent = asString(u.parent, "storage.under.parent")
  const subfolder = asString(u.subfolder, "storage.under.subfolder")
  if (/\\/.test(subfolder) || subfolder.split("/").some((t) => !t || t === "." || t === ".."))
    throw new DtError(`storage.under.subfolder "${subfolder}" must be a relative folder inside the owner's`)
  const f = c.fields[parent]
  const p = typeof f?.type === "string" && !f.many ? all[f.type] : undefined
  if (!p) throw new DtError(`storage.under.parent "${parent}" must be a field holding one reference to one collection`)
  if (p.storage.shape !== "folder" || p.storage.under || c.storage.shape === "folder" || c.storage.format === "binary")
    throw new DtError(
      `storage.under: ${c.name} records are stored as files inside folder-shaped ${p.name} records, which are not themselves stored under another`,
    )
  const res: NonNullable<Collection["under"]> = { parent, subfolder, collection: p.name }
  return res
}
