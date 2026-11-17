import { existsSync, readdirSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"

/** the file exists under exactly this spelling — a file system that ignores case must not turn one id into another */
export function present(base: string, path: string): boolean {
  if (!existsSync(path) || statSync(path).isDirectory()) return false
  let dir = base
  for (const seg of relative(base, path).split(sep)) {
    if (!readdirSync(dir).includes(seg)) return false
    dir = join(dir, seg)
  }
  return true
}
