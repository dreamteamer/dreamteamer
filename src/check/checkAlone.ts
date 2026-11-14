import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import os from "node:os"
import { ENGINE } from "./consts.ts"
import { engineRun } from "./engineRun.ts"
import { freshWorkspace } from "./freshWorkspace.ts"
import type { PackageJson } from "../types.ts"
import { childEnv } from "../workspace/childEnv.ts"
import { resolveNpm } from "../workspace/resolveNpm.ts"

const readPkg = (dir: string): PackageJson => JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))

/** Where this workspace holds a package by name: an inline module whose package.json names it, or node_modules/<name>. */
function locate(root: string, name: string): string | null {
  const inline = path.join(root, "modules")
  if (fs.existsSync(inline))
    for (const d of fs.readdirSync(inline)) {
      try {
        if (readPkg(path.join(inline, d)).name === name) return path.join(inline, d)
      } catch {
        /* not a module folder */
      }
    }
  const npm = path.join(root, "node_modules", name)
  return fs.existsSync(path.join(npm, "package.json")) ? fs.realpathSync(npm) : null
}

function npmPack(npm: string, dir: string, dest: string): string | undefined {
  const before = new Set(fs.readdirSync(dest))
  const r = spawnSync(npm, ["pack", "--silent", "--ignore-scripts", "--pack-destination", dest], {
    cwd: dir,
    encoding: "utf8",
    timeout: 120_000,
    env: childEnv(),
  })
  if (r.status !== 0) throw new Error(`npm pack failed in ${dir}: ${(r.stderr || r.stdout).trim().split("\n")[0]}`)
  return fs.readdirSync(dest).find(f => f.endsWith(".tgz") && !before.has(f))
}

/** The gate. `target` is the positional (`modules/<id>`); returns the exit code. */
export function checkAlone(
  ws: { root: string },
  {
    target,
    keep = false,
    log = console.log,
    error = console.error,
  }: { target?: string; keep?: boolean; log?: (line: string) => void; error?: (line: string) => void } = {}
): number {
  const usage = (m: string): number => {
    error(`✖ ${m}`)
    return 2
  }
  if (!target) return usage("check --alone takes modules/<id> — the inline module to judge")
  const m = /^modules\/([^/]+)\/?$/.exec(target)
  const dir = m && path.join(ws.root, "modules", m[1])
  if (!dir || !fs.existsSync(path.join(dir, "package.json")))
    return usage(`${target} is not an inline module of this workspace — check --alone takes modules/<id>`)
  const label = `modules/${m[1]}`
  let pkg
  try {
    pkg = readPkg(dir)
  } catch (e) {
    error(`✖ ${label}: package.json does not parse — ${e.message}`)
    return 1
  }
  if (!pkg.dreamteamer) {
    error(`✖ ${label}: package.json has no "dreamteamer" block — the engine would not see it as a module`)
    return 1
  }
  const npm = resolveNpm()
  if (!npm) {
    error(`✖ ${label}: no npm beside this node or on PATH — the gate packs the module with it`)
    return 1
  }

  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dt-check-alone-")))
  const refuse = (why: string): number => {
    error(`✖ ${label}: ${why}`)
    if (keep) log(`  kept: ${path.join(tmp, "ws")}`)
    else fs.rmSync(tmp, { recursive: true, force: true })
    return 1
  }
  try {
    // the module and its declared dependency closure, packed into one folder `dt install --from` reads
    const from = path.join(tmp, "from")
    fs.mkdirSync(from)
    npmPack(npm, dir, from)
    const deps: string[] = []
    const seen = new Set([pkg.name])
    const queue = [...(pkg.dreamteamer.dependencies ?? [])]
    while (queue.length) {
      const name = queue.shift()
      if (seen.has(name)) continue
      seen.add(name)
      const at = locate(ws.root, name)
      if (!at)
        return refuse(`dependency ${name} is not installed here — install it, or drop it from dreamteamer.dependencies`)
      npmPack(npm, at, from)
      deps.push(name)
      queue.push(...(readPkg(at).dreamteamer?.dependencies ?? []))
    }
    // a fresh workspace on this engine, the module installed the way a stranger installs it
    const root = path.join(tmp, "ws")
    fs.mkdirSync(root)
    freshWorkspace(root)
    const inst = engineRun(ENGINE, root, ["install", pkg.name, "--from", from, "--no-input"])
    if (inst.status !== 0 && inst.status !== 3)
      return refuse(
        (inst.stderr || inst.stdout)
          .trim()
          .split("\n")
          .find(l => l.trim()) ?? `dt install exited ${inst.status}`
      )
    const comp = engineRun(ENGINE, root, ["compile"])
    if (comp.status !== 0) return refuse(`compile: ${(comp.stderr || comp.stdout).trim().split("\n")[0]}`)
    const chk = engineRun(ENGINE, root, ["check"])
    if (chk.status !== 0)
      return refuse(
        `check: ${
          (chk.stdout + chk.stderr)
            .trim()
            .split("\n")
            .find(l => l.startsWith("✖")) ?? `exited ${chk.status}`
        }`
      )
    // the module's setup line(s), as a stranger's `dt status` will draw them
    const status = engineRun(ENGINE, root, ["status"])
    const setup = (status.stdout.split("setup:\n")[1] ?? "")
      .split("\n")
      .filter(l => l.startsWith("  ") && !/^\s+dreamteamer\b/.test(l))
    log(
      `✔ ${label} is publishable — packed, installed alone${deps.length ? ` (with ${deps.join(", ")})` : ""}, compiled, checked`
    )
    for (const l of setup) log(l)
    if (keep) log(`  kept: ${root}`)
    else fs.rmSync(tmp, { recursive: true, force: true })
    return 0
  } catch (e) {
    return refuse(e.message)
  }
}
