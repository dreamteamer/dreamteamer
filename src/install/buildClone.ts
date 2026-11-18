import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"

/**
 * a fresh clone with deps or a prepare/build script needs `npm install` to be usable
 * (deps land; `prepare` runs on install and builds dist). failure warns, never crashes.
 */
export function buildClone(dest: string, name: string): void {
  let cp
  try {
    cp = JSON.parse(fs.readFileSync(path.join(dest, "package.json"), "utf8"))
  } catch {
    return
  }
  if (!cp.dependencies && !cp.scripts?.prepare && !cp.scripts?.build) return
  console.log(`… npm install in git_modules/${name}`)
  const r = spawnSync("npm", ["install", "--no-fund", "--no-audit"], { cwd: dest, stdio: "inherit" })
  if (r.status !== 0)
    console.warn(
      `⚠ npm install failed in git_modules/${name} (exit ${r.status ?? r.error?.message}) — clone may be unbuilt; fix and re-run npm install there`
    )
}
