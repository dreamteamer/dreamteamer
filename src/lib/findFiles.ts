import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

/** the files below a folder whose names end in `suffix`, in sorted order, folder by folder */
export function findFiles(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...findFiles(p, suffix))
    else if (name.endsWith(suffix)) out.push(p)
  }
  return out
}
