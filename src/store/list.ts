import { DtError } from "../lib/DtError.ts"
import type { DtRecord } from "../types/DtRecord.ts"
import type { Model } from "../types/Model.ts"
import { get } from "./get.ts"
import { listIds } from "./listIds.ts"
import { openCollection } from "./openCollection.ts"

/** the records of a collection, optionally only those whose fields equal the given values */
export function list(model: Model, name: string, where: Record<string, string> = {}): DtRecord[] {
  const c = openCollection(model, name)
  for (const k of Object.keys(where))
    if (!c.fields[k] && k !== "created")
      throw new DtError(`${c.name} has no field ${k} to filter on — its fields are ${Object.keys(c.fields).join(", ")}`)
  return listIds(model, c.name)
    .map((t) => get(model, `${c.name}/${t}`))
    .filter((t) =>
      Object.entries(where).every(([k, v]) =>
        // eslint-disable-next-line @typescript-eslint/no-base-to-string -- compared as text, as typed after --filter
        [t.data[k]].flat().some((x) => x !== undefined && x !== null && String(x) === v),
      ),
    )
}
