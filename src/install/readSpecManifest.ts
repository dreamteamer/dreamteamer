import path from "node:path"
import fs from "node:fs"
import { spawnSync } from "node:child_process"
import { childEnv } from "../lib/childEnv.ts"
import { indexFolder } from "./indexFolder.ts"
import { readTarballManifest } from "./lib/readTarballManifest.ts"
import { NPM_VIEW_FIELDS, parseNpmView } from "./parseNpmView.ts"
import { resolveNpm } from "../lib/npm/resolveNpm.ts"
import type { FolderIndex, SpecEntry } from "./types.ts"
import { isPathSpec, refuse, splitSpec } from "./versions.ts"

/**
 * One spec → its manifest and the spec npm will be handed. Kinds: `tarball` (a .tgz path, or a name
 * resolved from `--from`), `folder` (a development link), `registry` (a name, read with one
 * `npm view` — the only network call; `github:` and git URLs go the same way).
 */
export function readSpecManifest(
  spec: string,
  {
    from = null,
    index = null,
    npm = resolveNpm(),
    cwd = process.cwd(),
  }: { from?: string | null; index?: FolderIndex | null; npm?: string | null; cwd?: string } = {}
): SpecEntry {
  if (isPathSpec(spec, cwd)) {
    const abs = path.resolve(cwd, spec.replace(/^file:/, ""))
    if (fs.statSync(abs).isDirectory()) {
      const file = path.join(abs, "package.json")
      if (!fs.existsSync(file)) throw refuse(`${spec}: a folder with no package.json`)
      return { kind: "folder", spec: abs, manifest: JSON.parse(fs.readFileSync(file, "utf8")) }
    }
    return { kind: "tarball", spec: abs, manifest: readTarballManifest(abs) }
  }
  const { name, version } = splitSpec(spec)
  if (from) {
    const idx = index ?? indexFolder(from)
    const candidates = idx.get(name) ?? []
    const pick = version ? candidates.find(c => c.version === version) : candidates[0]
    if (!pick)
      throw refuse(
        `no ${version ? `${name}@${version}` : name} in ${from}${candidates.length ? ` (it has ${candidates.map(c => c.version).join(", ")})` : ""}`
      )
    return { kind: "tarball", spec: pick.file, manifest: pick.manifest }
  }
  if (!npm) throw refuse("cannot read the registry — node found, npm not on PATH")
  const r = spawnSync(npm, ["view", spec, ...NPM_VIEW_FIELDS], {
    encoding: "utf8",
    cwd,
    env: childEnv(),
    timeout: 120_000,
  })
  return parseNpmView(spec, r)
}
