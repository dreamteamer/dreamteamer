import { existsSync, readdirSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { splitRef } from "../model/splitRef.ts"
import type { Model } from "../types/Model.ts"
import { checkId } from "./checkId.ts"
import { present } from "./present.ts"
import { recordPath } from "./recordPath.ts"

/** a reference names a record that exists, a source the model holds, or an id the exports manifest vouches for */
export function refExists(model: Model, ref: string): boolean {
  const at = splitRef(model, ref)
  if (!at) return false
  if (model.exports[at.collection]?.includes(at.id)) return true
  const src = model.sources[at.collection]
  if (src) return Object.hasOwn(src, at.id)
  const c = model.collections[at.collection]
  try {
    if (c.storage.format !== "binary") return present(join(model.root, c.storage.path), recordPath(model, c, at.id))
    // a binary record is the file itself, <id>.<suffix>.<extension>
    checkId(at.id)
    const dir = dirname(join(model.root, c.storage.path, at.id))
    return existsSync(dir) && readdirSync(dir).some((t) => t.startsWith(`${basename(at.id)}.${c.storage.suffix}.`))
  } catch {
    return false
  }
}
