import fs from "node:fs"
import path from "node:path"
import type { InstallDriftRow, Workspace } from "../types.ts"
import { declaredDeps } from "./declaredDeps.ts"

/** A version string as an exact pin writes it (`0.53.0`, `1.2.3-rc.1`), not a range. */
const EXACT = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/

/**
 * Every declared package whose installed version differs from the one this checkout pins: package-lock.json's entry,
 * else an exact package.json pin. What a teammate's pushed upgrade looks like after a pull — the pins moved,
 * node_modules did not — and what `dt install` then makes match. A missing package is not drift (`dt install` reports
 * it as missing), nor is a development link (never pinned), nor a ranged pin with no lockfile (no single answer).
 */
export function installDrift(ws: Workspace): InstallDriftRow[] {
  let lock: { packages?: Record<string, { version?: string }> } = {}
  try {
    lock = JSON.parse(fs.readFileSync(path.join(ws.root, "package-lock.json"), "utf8"))
  } catch {
    /* no lockfile: the exact pins in package.json are all there is */
  }
  const specs: Record<string, string> = { ...ws.pkg?.devDependencies, ...ws.pkg?.dependencies }
  const out: InstallDriftRow[] = []
  for (const name of declaredDeps(ws)) {
    const dir = path.join(ws.root, "node_modules", name)
    let installed: string | undefined
    try {
      if (fs.lstatSync(dir).isSymbolicLink()) continue
      installed = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version
    } catch {
      continue
    }
    const locked = lock.packages?.[`node_modules/${name}`]?.version
    const pinned = locked ?? (EXACT.test(specs[name] ?? "") ? specs[name] : undefined)
    if (pinned && installed && pinned !== installed) out.push({ name, pinned, installed })
  }
  return out
}
