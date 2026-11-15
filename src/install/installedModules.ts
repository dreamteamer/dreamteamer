import fs from "node:fs"
import path from "node:path"
import type { PackageJson, Workspace } from "../types.ts"
import { discoverModules } from "../workspace/discoverModules.ts"

/** One installed module, by package name. */
interface InstalledModule {
  name: string
  version: string | null
  linked: boolean
  manifest: PackageJson
  channel: string
}

// ---- the closure --------------------------------------------------------------------------------

/** The modules already here, by package name: version, whether it is a development link, its manifest. */
export function installedModules(ws: Workspace): Map<string, InstalledModule> {
  const out = new Map<string, InstalledModule>()
  const { modules } = discoverModules(ws.root, ws.pkg)
  for (const m of modules) {
    let manifest: PackageJson = {}
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(m.root, "package.json"), "utf8"))
    } catch {
      /* a module with no manifest is not a package */
    }
    const name = manifest.name ?? m.name
    let linked = false
    try {
      linked = fs.lstatSync(path.join(ws.root, "node_modules", name)).isSymbolicLink()
    } catch {
      /* not under node_modules */
    }
    out.set(name, { name, version: manifest.version ?? null, linked, manifest, channel: m.channel })
  }
  return out
}
