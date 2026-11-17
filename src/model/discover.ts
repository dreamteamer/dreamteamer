import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { asObject } from "../lib/asObject.ts"
import { asOptional } from "../lib/asOptional.ts"
import { asString } from "../lib/asString.ts"
import { asNames } from "../lib/asNames.ts"
import { DtError } from "../lib/DtError.ts"
import { isObject } from "../lib/isObject.ts"
import { messageOf } from "../lib/messageOf.ts"
import { readOr } from "../lib/readOr.ts"
import type { Issue } from "../types/Issue.ts"
import type { Layer } from "../types/Layer.ts"
import type { Module } from "../types/Module.ts"
import { readModule } from "./readModule.ts"
import { systemModule } from "./systemModule.ts"

/** the package.json in a folder, read leniently: anything else, or none, is an empty map */
function manifestOf(dir: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
    return isObject(v) ? v : {}
  } catch {
    return {}
  }
}

/** Which modules does this workspace have? The engine's own system module first, then npm's and its own; this only reads. */
export function discover(root: string) {
  const file = join(root, "package.json")
  if (!existsSync(file)) throw new DtError(`not a workspace: ${root} has no package.json`)
  let json: unknown
  try {
    json = JSON.parse(readFileSync(file, "utf8"))
  } catch (e) {
    throw new DtError(`not a workspace: ${file} is unreadable — ${messageOf(e)}`)
  }
  const issues: Issue[] = []
  const modules: Module[] = []
  // a package.json that is not a map has no dependencies, and so no modules; a key of the wrong type is an error,
  // and reads as absent
  const pkg = isObject(json) ? json : {}
  function map(v: unknown, where: string) {
    return readOr(issues, "package.json", () => asOptional(v, where, asObject), undefined) ?? {}
  }
  const config = map(pkg.dreamteamer, "dreamteamer")
  const disabled = new Set(
    readOr(issues, "package.json", () => asOptional(config.disable, "dreamteamer.disable", asNames), []),
  )
  const deps = map(pkg.dependencies, "dependencies")
  const devDeps = map(pkg.devDependencies, "devDependencies")
  for (const dep of [...new Set([...Object.keys(deps), ...Object.keys(devDeps)])].sort()) {
    // the released engine's package is the system module, which this engine ships its own copy of
    if (disabled.has(dep) || dep === "dreamteamer") continue
    const dir = join(root, "node_modules", dep)
    if (!existsSync(dir)) {
      issues.push({
        severity: "error",
        where: dep,
        message: "declared in package.json but not installed — run npm install",
      })
      continue
    }
    const m = readModule(dir, "npm", issues)
    if (m) modules.push(m)
  }
  const local = join(root, "modules")
  if (existsSync(local))
    for (const name of readdirSync(local).sort()) {
      const m = readModule(join(local, name), "workspace", issues)
      if (m) modules.push(m)
    }
  // a git_modules clone that is another workspace (its manifest names a workspace_module), or whose entry lists the
  // collections to read, lends its records; with `module: true` its workspace module too. Any other clone is a module,
  // or a bundle of modules under its modules/, as the released engine reads them. Review: the clones a clone needs
  // through its exports manifest are not followed, and a clone's modules are labelled npm until compile knows git
  const layers: Layer[] = []
  const git = map(config.git_modules, "dreamteamer.git_modules")
  const owns = new Set(modules.map((t) => t.name))
  const take = (dir: string) => {
    const m = readModule(dir, "npm", issues)
    if (m && !owns.has(m.name) && owns.add(m.name)) modules.push(m)
  }
  for (const [name, v] of Object.entries(git)) {
    const e = map(v, `dreamteamer.git_modules.${name}`)
    const at = `dreamteamer.git_modules.${name}.records`
    const records = readOr(issues, "package.json", () => asOptional(e.records, at, asNames), undefined)
    const dir = join(root, "git_modules", name)
    const own = map(manifestOf(dir).dreamteamer, `${dir}: dreamteamer`)
    const wm = typeof own.workspace_module === "string" ? own.workspace_module : undefined
    if (!records && !(e.module === true && existsSync(dir)) && existsSync(dir) && !wm) continue
    layers.push({ name, records, data: typeof own.data_path === "string" ? own.data_path : "data" })
    const message = `layer ${name} is not installed — its records are not read until it is cloned at git_modules/${name}`
    if (!existsSync(dir)) issues.push({ severity: "warning", where: "package.json", message })
    if (e.module === true && wm) take(join(dir, "modules", wm))
  }
  const clones = join(root, "git_modules")
  if (existsSync(clones))
    for (const name of readdirSync(clones).sort()) {
      const [dir, bundle] = [join(clones, name), join(clones, name, "modules")]
      const dt = manifestOf(dir).dreamteamer
      if (layers.some((t) => t.name === name) || !isObject(dt)) continue
      if (existsSync(bundle) && !dt.preset) for (const n of readdirSync(bundle).sort()) take(join(bundle, n))
      else take(dir)
    }
  if (
    !modules.length &&
    !issues.length &&
    !Object.hasOwn(deps, "dreamteamer") &&
    !Object.hasOwn(devDeps, "dreamteamer")
  )
    throw new DtError(`not a workspace: ${root} has no dreamteamer module among its dependencies or under modules/`)
  modules.unshift(systemModule())
  const names = new Set(modules.map((t) => t.name))
  for (const m of modules)
    for (const d of m.dependencies) {
      if (names.has(d)) continue
      const message = existsSync(join(root, "node_modules", d))
        ? `depends on module ${d}, which is in node_modules but not listed in this workspace's package.json — npm install --save-exact ${d}`
        : `depends on module ${d}, which is not installed`
      issues.push({ severity: "error", where: m.name, message })
    }
  // workspace settings the released engine honours and this one does not: say so once, in check
  const dataPath = readOr(
    issues,
    "package.json",
    () => asOptional(config.data_path, "dreamteamer.data_path", asString),
    undefined,
  )
  if (dataPath && dataPath !== "data")
    issues.push({
      severity: "warning",
      where: "package.json",
      message: `dreamteamer.data_path "${dataPath}" is not honoured — records are stored where each descriptor says`,
    })
  const res: { modules: Module[]; issues: Issue[]; config: Record<string, unknown>; layers: Layer[] } = {
    modules,
    issues,
    config,
    layers,
  }
  return res
}
