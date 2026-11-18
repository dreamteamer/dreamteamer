import zlib from "node:zlib"
import fs from "node:fs"
import type { PackageJson } from "../../types.ts"
import { refuse } from "../versions.ts"

/** `package/package.json` out of an npm tarball: gunzip, then walk the ustar headers (512-byte
 *  blocks; the size is octal at offset 124; a `./` prefix is tolerated). No dependency, no shell. */
export function readTarballManifest(file: string): PackageJson {
  const buf = zlib.gunzipSync(fs.readFileSync(file))
  let at = 0
  while (at + 512 <= buf.length) {
    const name = buf.toString("utf8", at, at + 100).replace(/\0.*$/s, "")
    if (!name) break
    const size = parseInt(
      buf
        .toString("utf8", at + 124, at + 136)
        .replace(/\0.*$/s, "")
        .trim() || "0",
      8
    )
    const type = buf[at + 156]
    const prefix = buf.toString("utf8", at + 345, at + 500).replace(/\0.*$/s, "")
    const full = (prefix ? `${prefix}/${name}` : name).replace(/^\.\//, "")
    if ((type === 48 || type === 0) && full === "package/package.json")
      return JSON.parse(buf.toString("utf8", at + 512, at + 512 + size))
    at += 512 + Math.ceil(size / 512) * 512
  }
  throw refuse(`${file}: no package/package.json inside the tarball`)
}
