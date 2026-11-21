import path from "node:path"
import { spawnSync } from "node:child_process"
import { parseUpdateArgs } from "../update/parseUpdateArgs.ts"
import { updateModules } from "../update/updateModules.ts"
import { updateCheck } from "../update/updateCheck.ts"
import { openWorkspace } from "../openWorkspace.ts"
import { emit } from "../lib/emit.ts"
import { childEnv } from "../lib/childEnv.ts"
import { EXIT } from "../lib/consts.ts"
import type { UpdateCheckRow } from "../types.ts"

export async function updateCommand(rest: string[]): Promise<number> {
  const ws = await openWorkspace()
  const u = parseUpdateArgs(rest)
  if (u.check) {
    const rows = await updateCheck(ws, { from: u.from })
    if (rest.includes("--json")) {
      emit(JSON.stringify({ packages: rows, outdated: rows.filter(r => r.outdated).length }, null, 2))
      return EXIT.done
    }
    printCheck(rows)
    return EXIT.done
  }
  if (u.all) {
    // the engine first, in THIS process (the old engine); then the modules, by the engine just installed — a module's
    // closure and compile are judged by the engine that will run it
    const rows = await updateCheck(ws, { from: u.from })
    const forward = (extra: string[]) => [
      ...extra,
      ...(u.from ? ["--from", u.from] : []),
      ...[...u.allow].flatMap(a => ["--allow", a]),
      ...(u.noCommit ? ["--no-commit"] : []),
    ]
    if (rows.find(r => r.kind === "engine")?.outdated) {
      const code = await updateModules(ws, { ...u, engine: true, name: null, version: null }, { open: openWorkspace })
      if (code !== EXIT.done) return code
      const bin = path.join(ws.root, "node_modules", "dreamteamer", "bin", "dreamteamer.js")
      const r = spawnSync(process.execPath, [bin, "update", ...forward(["--all"])], {
        cwd: ws.root,
        stdio: "inherit",
        env: childEnv(),
      })
      return r.status ?? EXIT.failed
    }
    const modules = rows.filter(r => r.kind === "module" && r.outdated)
    if (!modules.length) {
      console.log("✔ every package is at its latest release — nothing to update")
      return EXIT.done
    }
    let worst: number = EXIT.done
    for (const m of modules) {
      const code = await updateModules(
        await openWorkspace(ws.root),
        { ...u, engine: false, name: m.name, version: null },
        { open: openWorkspace }
      )
      if (code !== EXIT.done) worst = code
    }
    return worst
  }
  if (!u.engine && !u.name)
    throw new Error(
      "dt update needs a target — <name>[@<version>] moves one module's pin, --engine the engine's, --all every outdated one, --check lists them"
    )
  return await updateModules(ws, u, { open: openWorkspace })
}

/** `dreamteamer  0.52.0 → 0.53.0`, one line per package, then the count and the verb that moves them. */
function printCheck(rows: UpdateCheckRow[]): void {
  const width = Math.max(...rows.map(r => r.name.length), 10)
  for (const r of rows) {
    const state = r.linked
      ? "a development link — not pinned"
      : r.error
        ? `✖ ${r.error}`
        : r.outdated
          ? `${r.installed} → ${r.latest}`
          : `${r.installed} (latest)`
    console.log(`  ${r.name.padEnd(width)}  ${state}`)
  }
  const n = rows.filter(r => r.outdated).length
  console.log(
    n ? `${n} of ${rows.length} can move forward — dt update --all` : `✔ all ${rows.length} at their latest release`
  )
}
