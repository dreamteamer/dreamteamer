import path from "node:path"
import { EXT } from "./records.ts"
import { storageOf } from "./storageOf.ts"
import type { Descriptor } from "../types.ts"

/** The id a record file carries, or null when this path is not a record of `d`.
 *  `relPath` is relative to the collection's data directory.
 *
 *  THE ONLY PLACE a filename becomes an id. store, check and events each carried their own copy of
 *  `endsWith('.' + suffix + EXT[format])`, which is three places to update and two to forget.
 *
 *  `format: binary` records are opaque bytes whose extension is whatever was imported, so their tail is
 *  `.<suffix>.<ONE extension segment>` — one, because `x.asset.tar.gz` in the folder is an archive
 *  someone dropped there, and calling it a record would hide it from `check`'s stray report.
 *
 *  An id is a POSIX path on every OS: callers hand in `path.relative` output, which on Windows is
 *  `2026\10\x.note.md` — an id no reference, pattern or `dt get` would ever match. */
export function idFromRecordPath(d: Descriptor, relPath: string): string | null {
  relPath = relPath.split(path.sep).join("/")
  const { suffix, format } = storageOf(d)
  if (format === "binary") {
    const lit = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const m = new RegExp(`^(.+)\\.${lit}\\.[A-Za-z0-9]+$`).exec(relPath)
    return m ? m[1] : null
  }
  const tail = `.${suffix}${EXT[format]}`
  return relPath.endsWith(tail) ? relPath.slice(0, -tail.length) : null
}
