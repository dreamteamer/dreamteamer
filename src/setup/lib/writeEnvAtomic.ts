import fs from "node:fs"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { EnvRefusal, tempPrefix } from "./env-write.ts"
import { fingerprint } from "./fingerprint.ts"

/** Is any component of `.env` under `root` a symlink, or does the path leave the root? */
function confinedEnv(root: string): string {
  const real = fs.realpathSync(root)
  const target = path.join(real, ".env")
  let st = null
  try {
    st = fs.lstatSync(target)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  if (st?.isSymbolicLink())
    throw new EnvRefusal(
      "symlink",
      ".env is a symlink — a symlinked file is never written; replace the link with a regular file first"
    )
  return target
}

/**
 * Replace `<root>/.env` with `content` by rename, only while it still has fingerprint `expect`
 * (`absent` for a file that did not exist). The temporary file is removed on every failure this
 * process survives; an existing file keeps its mode, a new one is created owner-only. The last check
 * and the rename are two calls, not a compare-and-swap — optimistic, kept as short as it can be.
 */
export function writeEnvAtomic(root: string, content: string, expect: string): string {
  const target = confinedEnv(root)
  const stale = () => new EnvRefusal("changed", ".env changed after the preview — nothing was written; plan again")
  if (fingerprint(target) !== expect) throw stale()
  let mode = 0o600
  try {
    mode = fs.statSync(target).mode & 0o777
  } catch {
    /* a new file */
  }
  const temp = path.join(
    path.dirname(target),
    `${tempPrefix(target)}${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  )
  const fd = fs.openSync(temp, "wx", mode)
  try {
    try {
      fs.writeFileSync(fd, content)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    confinedEnv(root)
    if (fingerprint(target) !== expect) throw stale()
    fs.renameSync(temp, target)
  } catch (error) {
    fs.rmSync(temp, { force: true })
    throw error
  }
  return fingerprint(target)
}
