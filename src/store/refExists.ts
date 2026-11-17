import { existsSync, readdirSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { splitRef } from "../model/splitRef.ts"
import type { Model } from "../types/Model.ts"
import { checkId } from "./checkId.ts"
import { find } from "./find.ts"
import { rootsOf } from "./rootsOf.ts"

/** a reference names a record that exists, a source the model holds, or an id the exports manifest vouches for */
export function refExists(model: Model, ref: string): boolean {
  const at = splitRef(model, ref)
  if (!at) return false
  if (model.exports[at.collection]?.includes(at.id)) return true
  const src = model.sources[at.collection]
  if (src) return Object.hasOwn(src, at.id)
  const c = model.collections[at.collection]
  try {
    if (c.storage.format !== "binary") return find(model, c, at.id) !== undefined
    // a binary record is the file itself, <id>.<suffix>.<extension>, in any of its collection's folders
    checkId(at.id)
    const name = `${basename(at.id)}.${c.storage.suffix}.`
    const dirs = rootsOf(model, c).map((t) => dirname(join(t.dir, at.id)))
    return dirs.some((t) => existsSync(t) && readdirSync(t).some((n) => n.startsWith(name)))
  } catch {
    return false
  }
}
