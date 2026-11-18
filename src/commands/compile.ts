import fs from "node:fs"
import path from "node:path"
import { compile, kindsOf } from "../compile/compile.ts"
import { openWorkspace } from "../openWorkspace.ts"
import type { Workspace } from "../types.ts"

/** Returns nothing under `--watch`: the watcher keeps the process alive, so there is no exit code yet. */
export async function run(args: string[]): Promise<number | void> {
  const ws = await openWorkspace()
  const code = compile(ws)
  if (!args.includes("--watch")) return code
  console.log("… watching sources (modules/*, git_modules/*, and the workspace root) — ctrl-c to stop")
  watchAndRecompile(ws)
}

function watchAndRecompile(ws: Workspace): void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const trigger = (_: unknown, file: string | Buffer | null): void => {
    if (file && /^\./.test(String(file))) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      try {
        compile(ws)
      } catch (e) {
        console.error(`✖ ${e.message}`)
      }
    }, 200)
  }
  // 'system' plus the flat kinds: the classic layout can put sources at the workspace root under
  // either spelling, and a watcher that misses one makes --watch quietly stop recompiling.
  for (const dir of ["system", ...kindsOf(ws), "modules", "git_modules"].map(d => path.join(ws.root, d))) {
    if (fs.existsSync(dir)) fs.watch(dir, { recursive: true }, trigger)
  }
}
