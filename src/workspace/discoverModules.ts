import fs from "node:fs"
import path from "node:path"
import type { PackageJson, Workspace } from "../types.ts"
import { disablesPackage, isPackageEntry } from "../extensions/extensions.ts"
import type { ModuleSource } from "./types.ts"

/**
 * module discovery, two channels in precedence order: inline modules/* > npm deps
 * (declared in package.json, NOT a node_modules scan).
 * same NAME in two channels = the same module delivered twice — the more local
 * copy wins (npm-link semantics); shadows are returned for warning/status, never
 * compiled. different-name identity collisions stay hard errors downstream.
 */
export function discoverModules(
  root: string,
  pkg: Workspace["pkg"]
): {
  modules: { name: string; root: string; channel: string }[]
  shadows: { name: string; winner: string; loser: string }[]
  disabledModules: string[]
} {
  const byName = new Map<string, ModuleSource>() // name -> {name, root, channel}
  const shadows: { name: string; winner: string; loser: string }[] = [] // {name, winner, loser} — channels
  // A BARE `dreamteamer.disable` entry names a whole module; `<module>/<entity>` names one entity and
  // is applied per source at compile time. The bare form is what lets a workspace take a PACKAGE of
  // modules and keep only the ones it wants — a disabled module is simply never discovered, so every
  // caller (compile, status, install) sees the same set.
  const disable = pkg?.dreamteamer?.disable ?? []
  const disabledHits = new Set<string>()
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
  // A PACKAGE OF MODULES: a dependency whose root carries `modules/` bundles several
  // modules — its sub-modules are the modules, and the root itself is never compiled. One
  // `npm install` then delivers a whole family, and `disable` cherry-picks from it.
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
    // A MODULE PRESET is never a bundle: it lists modules and ships none, so a `modules/` folder in
    // one is the package pass's refusal to make, not a family to unpack.
    const bundle = path.join(srcRoot, "modules")
    if (!readPkg(srcRoot)?.dreamteamer?.preset && fs.existsSync(bundle) && fs.statSync(bundle).isDirectory()) {
      scanDir(bundle, channel, false)
      return
    }
    tryAdd(name, srcRoot, channel)
  }
  scanDir(path.join(root, "modules"), "inline", false)
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).sort()) {
    const srcRoot = path.join(root, "node_modules", dep)
    const mpkg = readPkg(srcRoot)
    if (mpkg) tryAddOrUnpack(mpkg.name ?? dep, srcRoot, "npm")
  }
  return { modules: [...byName.values()], shadows, disabledModules: [...disabledHits] }
}
