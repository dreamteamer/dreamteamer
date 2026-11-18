import fs from "node:fs"
import path from "node:path"
import type { PackageJson } from "../types.ts"
import { readTarballManifest } from "./lib/readTarballManifest.ts"
import type { FolderIndex } from "./types.ts"
import { compareVersions, refuse } from "./versions.ts"

/**
 * Every tarball in a folder, indexed by package name, newest first (npm's own semver order via
 * `satisfies`): file names are never parsed — `npm pack` writes `fix-a-1.0.0.tgz` for `@fix/a`.
 */
export function indexFolder(dir: string): FolderIndex {
  const index: FolderIndex = new Map()
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw refuse(`--from ${dir}: not a folder`)
  for (const f of fs
    .readdirSync(dir)
    .filter(n => n.endsWith(".tgz"))
    .sort()) {
    const file = path.join(dir, f)
    let m: PackageJson
    try {
      m = readTarballManifest(file)
    } catch {
      continue
    }
    if (!m?.name || !m.version) continue
    ;(index.get(m.name) ?? index.set(m.name, []).get(m.name)).push({ version: m.version, file, manifest: m })
  }
  for (const list of index.values()) list.sort((a, b) => compareVersions(b.version, a.version))
  return index
}
