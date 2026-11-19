import type { Fields } from "../types.ts"
import { fieldsOf, idsOf } from "../record/descriptor.ts"
import { storageOf } from "../record/storageOf.ts"
import { normalizeTemporal } from "./lib/normalizeTemporal.ts"
import path from "node:path"
import type { Store } from "./Store.ts"

export function createdOf(
  store: Store,
  collection: string,
  id: string,
  fields: Fields,
  file: string
): string | undefined {
  const d = store.descriptor(collection)
  if (!fieldsOf(d).created) return undefined
  if (fields?.created) return fields.created as string
  if (storageOf(d).external) return undefined // outside every repo here: no commit ever held it
  const from = [idsOf(d).from ?? []].flat()
  if (/^\{\{\s*created\b/.test(String(from[0] ?? ""))) {
    const day = /(\d{4}-\d{2}-\d{2})/.exec(id)?.[1]
    if (day) return normalizeTemporal(day, "date-time")
  }
  return store.addedDates(collection).get(path.relative(store.root, file).split(path.sep).join("/"))
}
