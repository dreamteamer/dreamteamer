import path from "node:path"
import fs from "node:fs"

/**
 * A module's source folder for one kind. The layout is FLAT — `<module>/skills`, beside `data/` —
 * because KINDS is already the allowlist and the extra `system/` level named nothing the engine
 * reads. `<module>/system/<kind>` is still accepted so a module can be moved independently of the
 * engine that reads it (they are separate repos on separate pins).
 *
 * Returns the FLAT path when neither exists, so a caller that creates the folder creates it in the
 * layout we want. `bothLayouts` reports the split case, which compile warns about — a module with
 * half its sources in each place compiles the flat half and silently drops the rest otherwise.
 */
export function kindDir(root: string, kind: string): string {
  const flat = path.join(root, kind)
  if (fs.existsSync(flat)) return flat
  const nested = path.join(root, "system", kind)
  return fs.existsSync(nested) ? nested : flat
}
