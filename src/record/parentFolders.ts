import fs from "node:fs"
import path from "node:path"

/**
 * `[id, folder]` for every record folder in a folder-shape collection's directory, sorted by id.
 * A folder without its entry file is still listed: records placed under it must stay discoverable
 * (`check` reports the missing entry on the parent and the dangling owner on each child).
 */
export function parentFolders(parentDir: string): [name: string, dir: string][] {
  if (!fs.existsSync(parentDir)) return []
  const out: [string, string][] = []
  for (const e of fs.readdirSync(parentDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith(".") || !e.isDirectory()) continue
    out.push([e.name, path.join(parentDir, e.name)])
  }
  return out
}
