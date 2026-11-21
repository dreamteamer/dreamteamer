import fs from "node:fs"
import path from "node:path"
import { declaredDeps } from "./declaredDeps.ts"
import { installDrift } from "./installDrift.ts"
import { resolves } from "./resolves.ts"
import type { PackageJson, Workspace } from "../types.ts"
import { describeCheckout } from "../lib/git/describeCheckout.ts"
import { discoverModules } from "../workspace/discoverModules.ts"
import { staleness } from "../compile/staleness.ts"

const isLink = (p: string): boolean => {
  try {
    return fs.lstatSync(p).isSymbolicLink() && fs.existsSync(p)
  } catch {
    return false
  }
}

/**
 * Every declared local asset, workspace-level (root-relative) and module-level (module-relative),
 * DEDUPED by rel with the first declaration winning: a step's id is `asset:<rel>`, so two modules
 * declaring the same path would plan two steps under one id and the second would be dropped
 * silently by any id-keyed read of the board.
 */
function declaredLocalAssets(ws: Workspace): { rel: string; module: string | null }[] {
  const seen = new Map<string, { rel: string; module: string | null }>() // rel → {rel, module}
  const add = (raw: string, module: string | null): void => {
    // ⚠ A REL MAY NOT CLIMB OUT OF THE WORKSPACE. `placeLink` writes wherever the rel points, so
    // `local_assets: ['../../x']` in a careless module declaration would drop a symlink beside
    // the workspace with nothing consulted. Refused when the plan is BUILT, so the board never
    // prints a step it must not run. (Task 4 teaches compile the same rule; a runtime that
    // writes outside the root should not wait for the compiler to be run.)
    const rel = path.normalize(raw)
    if (path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`)) {
      throw new Error(
        `local_assets: "${raw}"${module ? ` (declared by module ${module})` : ""} resolves outside the workspace root — a local asset must be a path INSIDE the workspace`
      )
    }
    if (!seen.has(rel)) seen.set(rel, { rel, module })
  }
  for (const rel of ws.pkg.dreamteamer?.local_assets ?? []) add(rel, null)
  for (const m of discoverModules(ws.root, ws.pkg).modules) {
    let mp: PackageJson = {}
    try {
      mp = JSON.parse(fs.readFileSync(path.join(m.root, "package.json"), "utf8"))
    } catch {
      /* no package.json */
    }
    for (const rel of mp.dreamteamer?.local_assets ?? []) add(path.relative(ws.root, path.join(m.root, rel)), m.name)
  }
  return [...seen.values()]
}

/**
 * What is true of this checkout right now — the only function here that reads the disk, so
 * `planInstall` stays pure and the whole board is decidable from this one object.
 */
export function observeState(ws: Workspace) {
  const checkout = describeCheckout(ws.root)
  const here = (rel: string): string => path.join(ws.root, rel),
    there = (rel: string): string => path.join(checkout.primary, rel)
  const s = staleness(ws.root)
  return {
    checkout,
    missingDeps: declaredDeps(ws).filter(d => !resolves(here(path.join("node_modules", d)))),
    // installed, but not the version the checkout pins — a teammate's pushed upgrade after a pull
    drift: installDrift(ws),
    hasEnv: resolves(here(".env")),
    envIsLink: isLink(here(".env")),
    primaryHasEnv: resolves(there(".env")),
    localAssets: declaredLocalAssets(ws).map(a => ({
      ...a,
      presentHere: resolves(here(a.rel)),
      isLinkHere: isLink(here(a.rel)),
      presentInPrimary: resolves(there(a.rel)),
    })),
    stale: !s.compiled || s.stale.length > 0,
    postinstall: ws.pkg.dreamteamer?.postinstall ?? null,
  }
}
