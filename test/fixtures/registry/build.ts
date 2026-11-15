// Pack every module under src/ into one folder of tarballs — the offline "registry" `dt install --from`
// reads. Built per test run into a temp dir (tarballs are not committed), with plain `npm pack`, so
// the file names are exactly what npm gives a scoped package (`fix-a-1.0.0.tgz` for `@fix/a`).
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "src")
// the engine's two other fixture packages ride along, so one folder holds every offline module
const EXTRA = ["probe-setup", "probe-collide"].map(d =>
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", d)
)

/** Pack the fixture modules into `dest` (a fresh temp dir by default). Returns the folder. */
export function buildRegistry(dest = fs.mkdtempSync(path.join(os.tmpdir(), "dt-registry-")), npm = "npm") {
  fs.mkdirSync(dest, { recursive: true })
  for (const src of [
    ...fs
      .readdirSync(SRC)
      .sort()
      .map(d => path.join(SRC, d)),
    ...EXTRA,
  ]) {
    const d = path.basename(src)
    const r = spawnSync(npm, ["pack", src, "--pack-destination", dest, "--silent"], {
      encoding: "utf8",
      timeout: 60_000,
    })
    if (r.status !== 0) throw new Error(`npm pack ${d} failed (${r.status ?? r.error?.message}): ${r.stderr}`)
  }
  return dest
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(buildRegistry(process.argv[2]))
