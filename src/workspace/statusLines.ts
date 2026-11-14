import fs from "node:fs"
import path from "node:path"
import type { StatusLine } from "./types.ts"
import type { PackageJson, SetupCheck, SetupContext, Workspace } from "../types.ts"
import { discoverModules } from "./discoverModules.ts"
import { fold } from "./fold.ts"
import { safeInspect } from "./safeInspect.ts"
import { receiptDir, skippedUnits, unitEnv } from "./setup.ts"
import type { DrivenUnit, Folded } from "./types.ts"
import { unitEnvFor } from "./unitEnvFor.ts"
import { units } from "./units.ts"

/** The setup section of `dt status`: one entry per unit, then one per package with no unit. */
export function statusLines(
  ws: Workspace,
  { processEnv = process.env }: { processEnv?: NodeJS.ProcessEnv } = {}
): StatusLine[] {
  const env = unitEnv(ws, processEnv)
  const lines: StatusLine[] = []
  const skipped = new Set(skippedUnits(ws))
  const byModule = new Map<string, DrivenUnit[]>()
  for (const u of units(ws)) (byModule.get(u.module) ?? byModule.set(u.module, []).get(u.module)).push(u)
  for (const [module, us] of byModule) {
    for (const u of us) {
      const { env: unitEnvHere, refused } = unitEnvFor(u, env)
      const ctx: SetupContext = {
        root: ws.root,
        ws,
        dt: null,
        env: unitEnvHere,
        tty: false,
        receiptDir: receiptDir(ws, u.id),
      }
      const checks = [...refused, ...safeInspect(u, ctx)]
      const f = fold(checks, { skipped: skipped.has(u.id) })
      lines.push({
        package: module,
        unit: u.id,
        grouped: us.length > 1,
        ...f,
        checks,
        next: nextCommand(u.id, f, checks),
      })
    }
  }
  // a skip entry no installed package provides is not silent: one line names it and how to clear it
  const provided = new Set([...byModule.values()].flat().map(u => u.id))
  for (const id of skipped)
    if (!provided.has(id))
      lines.push({
        package: null,
        unit: id,
        grouped: false,
        state: "skipped",
        detail: "no installed package provides it",
        verified: null,
        checks: [],
        next: `remove "${id}" from dreamteamer.setup.skipped in package.json`,
      })
  // every other installed module — an extension without a unit, or a plain module with no code at all —
  // reads `no setup`, naming the declared env keys and vars nobody set; the engine and the workspace's own
  // module are not modules anybody installs
  const own = ws.pkg?.dreamteamer?.workspace_module ?? "default"
  for (const m of discoverModules(ws.root, ws.pkg).modules) {
    let manifest: PackageJson = {}
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(m.root, "package.json"), "utf8"))
    } catch {
      /* no manifest */
    }
    const name = manifest.name ?? m.name
    if (name === "dreamteamer" || m.name === own || byModule.has(name)) continue
    const dt = manifest.dreamteamer ?? {}
    const needs = [...(dt.env ?? []), ...(dt.vars ?? [])].filter(
      k => env[k] === undefined || String(env[k]).trim() === ""
    )
    lines.push({
      package: name,
      unit: null,
      state: "no-setup",
      detail: needs.length ? `needs: ${needs.join(", ")}` : "",
      verified: null,
      checks: [],
      next: needs.length ? `set ${needs.join(", ")} in .env` : "",
    })
  }
  return lines
}

function nextCommand(unitId: string, f: Folded, checks: SetupCheck[]): string {
  if (f.state === "skipped") return `dt setup ${unitId}`
  if (f.state === "ready") return ""
  const fix = checks.find(c => c.status !== "ready" && c.status !== "configured" && c.fix)?.fix
  return fix ?? `dt setup ${unitId}`
}
