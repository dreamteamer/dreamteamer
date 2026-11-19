import path from "node:path"
import fs from "node:fs"

/**
 * The first SYMLINK on the way from `base` (exclusive) down to `target` (inclusive), or null.
 *
 * ⚠ Lexical validation of `under.subfolder` does not establish containment: a symlink dropped at
 * `data/companies/acme/meetings` points every "placed" write at wherever it likes, and a walk reads
 * whatever sits there as records. So a placed record is written and read only through REAL
 * directories below the parent collection's root — every existing component is `lstat`ed, and the
 * first link ends the enquiry. Components that do not exist yet are fine: they are about to be
 * created as real directories. The collection's own roots (`storage.path`, `data/` itself) are not
 * subject to this — a workspace may legitimately keep its data folder behind a link; the rule is
 * about what a RECORD FOLDER may contain.
 */
export function symlinkBelow(base: string, target: string): string | null {
  const rel = path.relative(base, target)
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null
  let p = base
  for (const seg of rel.split(path.sep)) {
    p = path.join(p, seg)
    let st
    try {
      st = fs.lstatSync(p)
    } catch {
      return null
    } // not there yet — nothing below can be a link either
    if (st.isSymbolicLink()) return p
  }
  return null
}
