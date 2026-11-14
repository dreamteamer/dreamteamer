import fs from "node:fs"
import path from "node:path"
import { layerEntries } from "../record/layerEntries.ts"
import { engineVersion } from "../runtime/runtime.ts"
import type { PackageJson, Workspace } from "../types.ts"
import { disablesPackage } from "./extensions.ts"
import { satisfies } from "./satisfies.ts"

/** The modules that declare an extension entry: the workspace's own `modules/<id>/` first, then each
 *  clone under `git_modules/` (the clone's root, then the modules it bundles under `modules/`), then its
 *  direct dependencies, each sorted by name — the three channels module content arrives through. A workspace module is the operator's own code, exactly
 *  like its `bin/`, so it needs no package and no npm — and it SHADOWS a dependency of the same name,
 *  the rule module content already follows. A module DISABLED by a bare `dreamteamer.disable` entry
 *  is not an extension either — disabling is how a workspace keeps a module and switches it off. */
export function declaredExtensions(
  ws: Workspace
): { name: string; version: string; dir: string; entry: string; env: string[]; vars: string[] }[] {
  const disable = ws.pkg?.dreamteamer?.disable ?? []
  const out: ReturnType<typeof declaredExtensions> = []
  const seen = new Set<string>()
  const consider = (dir: string, fallback: string): void => {
    let pkg: PackageJson
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))
    } catch {
      return
    }
    const entry = pkg.dreamteamer?.extension
    const name = pkg.name ?? fallback
    if (!entry || seen.has(name) || disablesPackage(disable, name)) return
    if (typeof entry !== "string")
      throw new Error(
        `${name}: dreamteamer.extension must be a path to the entry module (got ${JSON.stringify(entry)})`
      )
    seen.add(name)
    // a module whose engine floor is unmet is refused whole, its code with its content
    const range = pkg.dreamteamer.engine
    if (range && satisfies(engineVersion(), range) === false)
      return void console.warn(
        `✖ extension ${name} needs engine "${range}" — this is ${engineVersion()}, so it is not loaded`
      )
    out.push({
      name,
      version: pkg.version ?? "0.0.0",
      dir,
      entry: path.join(dir, entry),
      env: pkg.dreamteamer.env ?? [],
      vars: pkg.dreamteamer.vars ?? [],
    })
  }
  let inline: string[] = []
  try {
    inline = fs.readdirSync(path.join(ws.root, "modules")).sort()
  } catch {
    /* no modules/ */
  }
  for (const id of inline) consider(path.join(ws.root, "modules", id), id)
  const listed = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir).sort()
    } catch {
      return []
    }
  }
  const layers = new Set(layerEntries(ws.pkg, ws.root).map(l => l.name))
  for (const clone of listed(path.join(ws.root, "git_modules"))) {
    if (layers.has(clone)) continue // a record layer: another workspace's data, never its code
    const root = path.join(ws.root, "git_modules", clone)
    let rootName = clone
    try {
      rootName = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).name ?? clone
    } catch {
      /* no manifest */
    }
    if (disablesPackage(disable, rootName)) continue // a disabled bundle takes its children with it
    consider(root, clone)
    for (const id of listed(path.join(root, "modules"))) consider(path.join(root, "modules", id), id)
  }
  for (const dep of Object.keys({ ...ws.pkg?.dependencies, ...ws.pkg?.devDependencies }).sort())
    consider(path.join(ws.root, "node_modules", dep), dep)
  return out
}
