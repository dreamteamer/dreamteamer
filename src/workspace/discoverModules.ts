import fs from "node:fs"
import path from "node:path"
import { layerEntries } from "./layerEntries.ts"
import type { PackageJson, Workspace } from "../types.ts"
import { disablesPackage, isPackageEntry } from "./extensions.ts"
import type { ModuleSource } from "./types.ts"

// module discovery, three channels in precedence order: inline modules/* >
// git_modules/* > npm deps (declared in package.json, NOT a node_modules scan).
// same NAME in two channels = the same module delivered twice — the more local
// copy wins (npm-link semantics); shadows are returned for warning/status, never
// compiled. different-name identity collisions stay hard errors downstream.
export function discoverModules(
  root: string,
  pkg: Workspace["pkg"]
): {
  modules: { name: string; root: string; channel: string; layer?: string }[]
  shadows: { name: string; winner: string; loser: string }[]
  disabledModules: string[]
  layerRefusals: string[]
} {
  const byName = new Map<string, ModuleSource>() // name -> {name, root, channel}
  const shadows: { name: string; winner: string; loser: string }[] = [] // {name, winner, loser} — channels
  // A BARE `dreamteamer.disable` entry names a whole module; `<module>/<entity>` names one entity and
  // is applied per source at compile time. The bare form is what lets a workspace take a PACKAGE of
  // modules and keep only the ones it wants — a disabled module is simply never discovered, so every
  // caller (compile, status, install) sees the same set.
  const disable = pkg?.dreamteamer?.disable ?? []
  const disabledHits = new Set<string>()
  // A clone that is a WORKSPACE (its own manifest names `workspace_module`), or whose entry lists
  // `records`, is a RECORD LAYER — another workspace's data read here — never a bundle: its own
  // modules/ would otherwise unpack and collide with ours. With `module: true` its ONE workspace
  // module is a source too (below).
  const layerList = layerEntries(pkg, root)
  const layers = new Set(layerList.map(l => l.name))
  // the same rule the extension loader applies (full package name, or its scope-stripped id), so a
  // disabled package loses its content AND its code together
  const disabled = (name: string): boolean => {
    const hit = disable.find(d => isPackageEntry(d) && disablesPackage([d], name))
    if (hit) disabledHits.add(hit)
    return !!hit
  }
  const tryAdd = (name: string, srcRoot: string, channel: string): void => {
    if (disabled(name)) return
    const existing = byName.get(name)
    if (existing) {
      shadows.push({ name, winner: existing.channel, loser: channel })
      return
    }
    byName.set(name, { name, root: srcRoot, channel })
  }
  const readPkg = (dir: string): PackageJson | null => {
    try {
      const mpkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))
      return "dreamteamer" in mpkg ? mpkg : null
    } catch {
      return null
    } // no package.json, or unparseable — not a module
  }
  // A PACKAGE OF MODULES: a dependency or a git clone whose root carries `modules/` bundles several
  // modules — its sub-modules are the modules, and the root itself is never compiled. One
  // `npm install` (or one clone) then delivers a whole family, and `disable` cherry-picks from it.
  // Inline `modules/*` never nest: a `modules/` folder at an inline module root stays the
  // unknown-folder compile error it always was, because the workspace's own tree has no reason to
  // bundle.
  const scanDir = (dir: string, channel: string, unpack: boolean): void => {
    if (!fs.existsSync(dir)) return
    for (const name of fs.readdirSync(dir).sort()) {
      const srcRoot = path.join(dir, name)
      const mpkg = readPkg(srcRoot)
      if (mpkg) (unpack ? tryAddOrUnpack : tryAdd)(mpkg.name ?? name, srcRoot, channel)
    }
  }
  const tryAddOrUnpack = (name: string, srcRoot: string, channel: string): void => {
    // ⚠ THE PACKAGE FIRST: disabling a bundle disables every module in it. Only the children used to
    // be checked, so `disable: ['@x/bundle']` stopped its code and compiled all of its content.
    if (disabled(name)) return
    const bundle = path.join(srcRoot, "modules")
    if (fs.existsSync(bundle) && fs.statSync(bundle).isDirectory()) {
      scanDir(bundle, channel, false)
      return
    }
    tryAdd(name, srcRoot, channel)
  }
  scanDir(path.join(root, "modules"), "inline", false)
  const gitDir = path.join(root, "git_modules")
  if (fs.existsSync(gitDir)) {
    for (const name of fs.readdirSync(gitDir).sort()) {
      if (layers.has(name)) continue
      const srcRoot = path.join(gitDir, name)
      const mpkg = readPkg(srcRoot)
      if (mpkg) tryAddOrUnpack(mpkg.name ?? name, srcRoot, "git")
    }
  }
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).sort()) {
    const srcRoot = path.join(root, "node_modules", dep)
    const mpkg = readPkg(srcRoot)
    if (mpkg) tryAddOrUnpack(mpkg.name ?? dep, srcRoot, "npm")
  }
  // A layer with `module: true` contributes the clone's WORKSPACE module — `modules/<workspace_module>`
  // as its own manifest names it — as a git-channel source, the way a bundle contributes its modules.
  // Kept out of `byName` on purpose: a name another channel holds must be REFUSED, never shadowed, and
  // compile does that, naming the entry. A clone not on disk contributes nothing, like any layer.
  const layerModules: ModuleSource[] = []
  const layerRefusals: string[] = []
  for (const l of layerList) {
    const clone = path.join(gitDir, l.name)
    if (!l.module || !fs.existsSync(clone)) continue
    const wm = readPkg(clone)?.dreamteamer?.workspace_module
    const srcRoot = wm ? path.join(clone, "modules", wm) : null
    const mpkg = srcRoot ? readPkg(srcRoot) : null
    if (!mpkg) {
      layerRefusals.push(
        `git_modules.${l.name}.module: ${wm ? `the clone names workspace_module "${wm}", but modules/${wm}/ holds no module package.json` : "the clone names no dreamteamer.workspace_module"} — there is no module to contribute. Drop \`module\`, or give the clone a workspace module.`
      )
    } else if (!disabled(mpkg.name ?? wm)) {
      layerModules.push({ name: mpkg.name ?? wm, root: srcRoot, channel: "git", layer: l.name })
    }
  }
  return { modules: [...byName.values(), ...layerModules], shadows, disabledModules: [...disabledHits], layerRefusals }
}
