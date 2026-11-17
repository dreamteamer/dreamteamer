import { readdirSync } from "node:fs"
import { join } from "node:path"

/** regular files below a folder; dotfiles, dot-directories and symbolic links are not listed */
export function listFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) listFiles(p, out)
    else if (e.isFile()) out.push(p)
  }
  return out
}
