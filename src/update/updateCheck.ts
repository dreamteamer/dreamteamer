import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import type { UpdateCheckRow, Workspace } from "../types.ts"
import { childEnv } from "../lib/childEnv.ts"
import { resolveNpm } from "../lib/npm/resolveNpm.ts"
import { installedModules } from "../install/installedModules.ts"
import { readSpecManifest } from "../install/readSpecManifest.ts"
import { NPM_VIEW_FIELDS, parseNpmView } from "../install/lib/parseNpmView.ts"
import { compareVersions } from "../install/versions.ts"
import type { SpecEntry } from "../install/types.ts"

/** How many `npm view` calls run at once: enough to make thirty modules a few seconds, few enough to be polite. */
const CONCURRENT_VIEWS = 8

/**
 * What `dt update` would move: the engine and every module installed from npm, each with its installed version and
 * the release `dt update <name>` (or `--engine`) would re-pin to. Read the same way update reads it — one `npm view`
 * per package, or the folder `--from` names — so a row that says `outdated` is exactly what `dt update --all` moves.
 * A development link is listed and never outdated; a package the registry did not answer carries `error`.
 */
export async function updateCheck(
  ws: Workspace,
  { npm = resolveNpm(), from = null }: { npm?: string | null; from?: string | null } = {}
): Promise<UpdateCheckRow[]> {
  const here: { name: string; kind: UpdateCheckRow["kind"]; installed: string | null; linked: boolean }[] = []
  const engineDir = path.join(ws.root, "node_modules", "dreamteamer")
  try {
    here.push({
      name: "dreamteamer",
      kind: "engine",
      installed: JSON.parse(fs.readFileSync(path.join(engineDir, "package.json"), "utf8")).version ?? null,
      linked: fs.lstatSync(engineDir).isSymbolicLink(),
    })
  } catch {
    /* no installed engine: nothing to compare against */
  }
  for (const m of installedModules(ws).values())
    if (m.channel === "npm" && m.name !== "dreamteamer")
      here.push({ name: m.name, kind: "module", installed: m.version, linked: m.linked })
  here.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "engine" ? -1 : 1))

  const latestOf = async (name: string): Promise<SpecEntry> =>
    from || !npm ? readSpecManifest(name, { from, npm, cwd: ws.root }) : view(npm, name, ws.root)
  const rows: UpdateCheckRow[] = new Array(here.length)
  let next = 0
  const worker = async () => {
    while (next < here.length) {
      const i = next++
      const p = here[i]
      if (p.linked) {
        rows[i] = { ...p, latest: null, outdated: false }
        continue
      }
      try {
        const latest = (await latestOf(p.name)).manifest.version ?? null
        rows[i] = {
          ...p,
          latest,
          outdated: !!latest && !!p.installed && compareVersions(latest, p.installed) > 0,
        }
      } catch (e) {
        rows[i] = { ...p, latest: null, outdated: false, error: (e as Error).message }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENT_VIEWS, here.length) }, worker))
  return rows
}

/** One `npm view` without blocking, parsed exactly as `readSpecManifest` parses its own. */
function view(npm: string, spec: string, cwd: string): Promise<SpecEntry> {
  return new Promise((resolve, reject) => {
    const child = spawn(npm, ["view", spec, ...NPM_VIEW_FIELDS], { cwd, env: childEnv() })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => child.kill(), 120_000)
    child.stdout.on("data", d => (stdout += d))
    child.stderr.on("data", d => (stderr += d))
    child.on("error", e => {
      clearTimeout(timer)
      reject(e)
    })
    child.on("close", status => {
      clearTimeout(timer)
      try {
        resolve(parseNpmView(spec, { status, stdout, stderr }))
      } catch (e) {
        reject(e)
      }
    })
  })
}
