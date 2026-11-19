import { spawnSync } from "node:child_process"
import path from "node:path"
import type { RunOptions, RunResult } from "../types.ts"

const IDENTITY = {
  GIT_AUTHOR_NAME: "dreamteamer check",
  GIT_AUTHOR_EMAIL: "check@example.invalid",
  GIT_COMMITTER_NAME: "dreamteamer check",
  GIT_COMMITTER_EMAIL: "check@example.invalid",
}

/** Run `engine`'s CLI in `cwd`, output captured, no stdin. */
export function engineRun(
  engine: string,
  cwd: string,
  args: string[],
  { env = {}, timeoutMs = 300_000, input }: RunOptions = {}
): RunResult {
  const r = spawnSync(process.execPath, [path.join(engine, "bin", "dreamteamer.js"), ...args], {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    env: { ...process.env, ...IDENTITY, NO_COLOR: "1", ...env },
    ...(input !== undefined ? { input } : { stdio: ["ignore", "pipe", "pipe"] }),
  })
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}
