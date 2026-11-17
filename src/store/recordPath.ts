import { existsSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"
import { DtError } from "../lib/DtError.ts"
import type { Collection } from "../types/Collection.ts"
import type { Model } from "../types/Model.ts"
import { checkId } from "./checkId.ts"
import { tail } from "./tail.ts"

/** the file of a record, refused when the id, the storage path or a symbolic link would lead out of its collection */
export function recordPath(model: Model, c: Collection, id: string): string {
  checkId(id)
  if (isAbsolute(c.storage.path))
    throw new DtError(
      `${c.name}: its storage path is absolute (${c.storage.path}) — this engine reads and writes only inside the workspace`,
    )
  const base = join(model.root, c.storage.path)
  const path = join(base, id + tail(c))
  if (!resolve(path).startsWith(resolve(model.root) + sep))
    throw new DtError(`${c.name}/${id}: its path leaves the workspace`)
  // the collection's folder may itself be a link to somewhere else; nothing below it may lead out of it
  let dir = dirname(path)
  while (!existsSync(dir) && dir.length > base.length) dir = dirname(dir)
  if (existsSync(dir) && existsSync(base) && !(realpathSync(dir) + sep).startsWith(realpathSync(base) + sep))
    throw new DtError(`${c.name}/${id}: a symbolic link leads out of the collection's folder`)
  return path
}
