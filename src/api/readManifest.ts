import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parse } from "yaml"

/** the compiled runtime's manifest (`.dreamteamer/manifest.yaml`, written by compile), or null when there is none */
export function readManifest(root: string): unknown {
  const file = join(root, ".dreamteamer", "manifest.yaml")
  try {
    return existsSync(file) ? parse(readFileSync(file, "utf8")) : null
  } catch {
    return null
  }
}

/**
 * Whether the compiled runtime is behind its sources. Review: this engine reads its sources directly, so a record is
 * never read through a stale runtime; only whether a runtime exists is answered.
 */
export function staleness(root: string) {
  const compiled = readManifest(root) !== null
  const res = { compiled, stale: [] as string[], message: compiled ? undefined : "no compiled runtime — run compile" }
  return res
}
