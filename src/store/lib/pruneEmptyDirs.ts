import fs from "node:fs"
import path from "node:path"

// remove now-empty parent dirs up to (not including) the collection root
// ⚠ NEVER THROWS. An empty directory left behind is cosmetic; a rename that already happened being
// reported as a failure because its leftover folder would not go is a duplicate record (R1b). The
// loop stops at the first directory it cannot remove — a permission, a concurrent write — and says
// nothing, because there is nothing a caller could do about it that would be better.
export function pruneEmptyDirs(dir: string, stopAt: string): void {
  try {
    while (dir !== stopAt && dir.startsWith(stopAt) && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir)
      dir = path.dirname(dir)
    }
  } catch {
    /* left in place */
  }
}
