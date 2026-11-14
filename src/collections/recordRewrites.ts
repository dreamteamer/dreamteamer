import fs from "node:fs"
import type { RecordRewrite } from "./types.ts"
import type { Store } from "../record/Store.ts"
import { bodyFieldOf } from "../record/descriptor.ts"
import { parseRecord } from "../record/records.ts"
import type { Fields } from "../types.ts"

/** Records of `collection` a value-level rewrite would change, with the fields it would write. */
export function recordRewrites(
  store: Store,
  collection: string,
  rewrite: (fields: Fields) => Fields | null
): RecordRewrite[] {
  const d = store.descriptors.get(collection)
  if (!d || !store.canRewrite(collection)) return []
  const bf = bodyFieldOf(d)
  const out: RecordRewrite[] = []
  for (const [, file] of store.ids(collection)) {
    let fields: Fields
    // a record that will not parse is skipped: `check` already reports it, and one bad record must
    // not wall off a schema change
    try {
      fields = parseRecord(file, d, bf)
    } catch {
      continue
    }
    const next = rewrite(fields)
    // the previous text goes with it, so a rewrite re-emits only the key it changed
    if (next) out.push({ file, fields: next, text: fs.readFileSync(file, "utf8") })
  }
  return out
}
