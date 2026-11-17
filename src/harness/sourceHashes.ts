import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { listFiles } from "../lib/listFiles.ts"
import { SOURCE_KINDS } from "../model/SOURCE_KINDS.ts"
import type { Model } from "../types/Model.ts"

/**
 * Every file compile reads, by its path from the workspace, with its sha256: the workspace's `package.json` and
 * `DREAMTEAMER.md`, and each module's `package.json` and source folders. What compile wrote is stale when this changes.
 */
export function sourceHashes(model: Model): Record<string, string> {
  const files = [join(model.root, "package.json"), join(model.root, "DREAMTEAMER.md")]
  for (const m of model.modules) {
    files.push(join(m.dir, "package.json"))
    for (const k of SOURCE_KINDS) if (existsSync(join(m.dir, k))) files.push(...listFiles(join(m.dir, k)))
  }
  const hash = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex")
  const key = (f: string) => relative(model.root, f).split(sep).join("/")
  return Object.fromEntries(files.filter((t) => existsSync(t)).map((t) => [key(t), hash(t)]))
}
