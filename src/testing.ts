import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { satisfies } from "./lib/semver.ts"
import { resolveNpm, childEnv } from "./lib/checkout.ts"
import { engineRun, freshWorkspace } from "./check/alone.ts"
import type { RunOptions, RunResult, TestWorkspace } from "./lib/types.ts"

export type { RunOptions, RunResult as Result, TestWorkspace as Workspace }

/** The engine running this file: its package root. */
export const ENGINE: string = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const VERSION = (JSON.parse(fs.readFileSync(path.join(ENGINE, "package.json"), "utf8")) as { version: string }).version

const made: string[] = []
let hooked = false
function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `dreamteamer-testing-${prefix}-`)))
  made.push(dir)
  if (!hooked) {
    hooked = true
    process.on("exit", () => {
      if (!process.env.DT_KEEP_FIXTURES) for (const d of made) fs.rmSync(d, { recursive: true, force: true })
    })
  }
  return dir
}

/** The CLI of the workspace's engine, in the workspace. */
export function run(ws: TestWorkspace, args: string[], opts: RunOptions = {}): RunResult {
  return engineRun(ws.engine, ws.root, args, { timeoutMs: 60_000, ...opts })
}

/**
 * A fresh workspace made by the engine's own `init`: the engine declared as a `file:` dependency and
 * linked before init, so init finds it present and asks no registry; git-initialised and committed.
 * `engine` (a package root) wins, then `DT_ENGINE_DIR`, then the engine running this file.
 */
export function createWorkspace({ engine }: { engine?: string } = {}): TestWorkspace {
  const eng = engine ?? (process.env.DT_ENGINE_DIR ? path.resolve(process.env.DT_ENGINE_DIR) : ENGINE)
  const root = tempDir("ws")
  const ws: TestWorkspace = { root, engine: eng, dt: (args, opts) => run(ws, args, opts) }
  freshWorkspace(root, eng)
  return ws
}

/** `npm pack` of a module folder into a temp folder; the tarball's path. */
export function pack(moduleDir: string): string {
  const npm = resolveNpm()
  if (!npm) throw new Error("no npm beside this node or on PATH — pack needs it")
  const dest = tempDir("pack")
  const r = spawnSync(npm, ["pack", "--silent", "--pack-destination", dest], {
    cwd: path.resolve(moduleDir),
    encoding: "utf8",
    timeout: 120_000,
    env: childEnv(),
  })
  if (r.status !== 0) throw new Error(`npm pack failed in ${moduleDir} (exit ${r.status}):\n${r.stderr}${r.stdout}`)
  const tgz = fs.readdirSync(dest).filter(f => f.endsWith(".tgz"))
  if (tgz.length !== 1) throw new Error(`npm pack left ${tgz.length} tarballs in ${dest}`)
  return path.join(dest, tgz[0])
}

/** `dt install` of a name, a tarball path, or a module folder (packed first, so its `files` list is
 *  what is installed). Never throws on the engine's exit: 3 (an input still needed) is a result. */
export function install(ws: TestWorkspace, spec: string, opts: RunOptions = {}): RunResult {
  const isFolder = !spec.endsWith(".tgz") && fs.existsSync(spec) && fs.statSync(spec).isDirectory()
  const target = isFolder ? pack(spec) : spec
  return run(ws, ["install", target, "--no-input"], { timeoutMs: 300_000, ...opts })
}

/** Does the running engine (or DT_ENGINE_DIR's) satisfy `range`? */
export function engineMeets(range: string): boolean {
  let version = VERSION
  if (process.env.DT_ENGINE_DIR) {
    try {
      version = JSON.parse(
        fs.readFileSync(path.join(path.resolve(process.env.DT_ENGINE_DIR), "package.json"), "utf8")
      ).version
    } catch {
      /* the running engine's */
    }
  }
  return satisfies(version, range) === true
}
