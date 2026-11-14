import fs from "node:fs"
import path from "node:path"

/**
 * One string that changes whenever a directory anywhere under `dir` gains or loses an entry — the
 * mtime of every directory in the tree, in walk order. Directories only: files are not stat'ed, so
 * this costs O(directories), not O(records). What a placed collection's id memo is keyed on, because
 * a root directory's own mtime says nothing about a file dropped three levels down (R4).
 */
export function dirTreeStamps(dir: string): string {
  const out: string[] = []
  const visit = (d: string): void => {
    let st
    try {
      st = fs.statSync(d)
    } catch {
      return
    }
    out.push(`${path.basename(d)}@${st.mtimeMs}`)
    let entries
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".")) visit(path.join(d, e.name))
  }
  visit(dir)
  return out.join(",")
}
