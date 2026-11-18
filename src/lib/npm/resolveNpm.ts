import fs from "node:fs"
import path from "node:path"

/**
 * npm, resolved BESIDE the running node first and on PATH second.
 *
 * ⚠ THE ORDER IS THE MEASUREMENT (spec §15). A hook runs under `sh`, which reads no startup file,
 * so PATH may carry nothing at all — while `process.execPath` is an absolute path to the node that
 * is running this line, and every installer that ships node ships npm beside it. Trusting PATH
 * first would pick a stale global npm on a machine that has both, and find nothing on a machine
 * reached through the shim. Returns null when neither resolves, which is a board line, not a throw.
 */
export function resolveNpm(execPath: string = process.execPath, env: NodeJS.ProcessEnv = process.env): string | null {
  const bin = process.platform === "win32" ? "npm.cmd" : "npm"
  // ⚠ EXECUTABLE, not merely present. `resolves` is `existsSync`, which is true of a DIRECTORY
  // called `npm` and of a file nobody may run — and this path is then spawned, so the difference
  // between "it is there" and "it can be executed" is the difference between a named board line
  // and an EACCES nobody planned for. A proof runner's `requires: { bin: … }` learned the same.
  const runnable = (p: string): boolean => {
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return fs.statSync(p).isFile()
    } catch {
      return false
    }
  }
  const beside = path.join(path.dirname(execPath), bin)
  if (runnable(beside)) return beside
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (dir && runnable(path.join(dir, bin))) return path.join(dir, bin)
  }
  return null
}
