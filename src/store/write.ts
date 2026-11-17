import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { DtError } from "../lib/DtError.ts"
import type { Collection } from "../types/Collection.ts"
import type { Model } from "../types/Model.ts"
import { recordPath } from "./recordPath.ts"
import { refuseBroken } from "./refuseBroken.ts"
import { validate } from "./validate.ts"

/**
 * Validate a record and replace its file in one rename — only if the file is still as it was read (`expectMtime`),
 * or still absent. A rejected write changes nothing; an unchecked one (a reverse field) is not validated.
 */
export function write(
  model: Model,
  c: Collection,
  id: string,
  data: Record<string, unknown>,
  text: string,
  expectMtime?: number,
  checked = true,
): string {
  refuseBroken(model)
  const path = recordPath(model, c, id)
  const issues = checked ? validate(model, c.name, id, data) : []
  if (issues.length) throw new DtError(`${c.name}/${id} rejected — nothing written`, issues)
  mkdirSync(dirname(path), { recursive: true })
  // a writer that was killed leaves its temporary file behind: clear old ones for this record
  for (const n of readdirSync(dirname(path)))
    if (n.startsWith(basename(path) + ".") && n.endsWith(".tmp")) {
      const p = join(dirname(path), n)
      if (Date.now() - statSync(p).mtimeMs > 60_000) rmSync(p, { force: true })
    }
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, text)
    // stale-write guard: the file must be as we read it (or still absent) at the moment we replace it
    const now = existsSync(path) ? statSync(path).mtimeMs : undefined
    if (now !== expectMtime) throw new DtError(`${c.name}/${id} changed on disk since it was read — nothing written`)
    renameSync(tmp, path)
  } finally {
    rmSync(tmp, { force: true })
  }
  return path
}
