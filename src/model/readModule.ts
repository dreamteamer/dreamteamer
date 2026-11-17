import { existsSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { asOptional } from "../lib/asOptional.ts"
import { asString } from "../lib/asString.ts"
import { asNames } from "../lib/asNames.ts"
import { isObject } from "../lib/isObject.ts"
import { messageOf } from "../lib/messageOf.ts"
import { readOr } from "../lib/readOr.ts"
import type { Issue } from "../types/Issue.ts"
import type { Module } from "../types/Module.ts"

/** manifest keys a module may carry that this engine sees and does not act on */
const NOT_ACTED_ON = ["extension", "nav", "setup", "preset", "env", "engine", "ignore", "vars"]

/**
 * The module in a folder, or null when its package.json has no `dreamteamer` key. A manifest that cannot be read is
 * an error, and so is a key of the wrong type, which then reads as absent. One name stands for a list of one.
 */
export function readModule(dir: string, origin: Module["origin"], issues: Issue[]): Module | null {
  const file = join(dir, "package.json")
  if (!existsSync(file)) return null
  let pkg: unknown
  try {
    pkg = JSON.parse(readFileSync(file, "utf8"))
  } catch (e) {
    issues.push({ severity: "error", where: file, message: `unreadable package.json: ${messageOf(e)}` })
    return null
  }
  if (!isObject(pkg) || typeof pkg.dreamteamer !== "object" || pkg.dreamteamer === null) return null
  const dt = isObject(pkg.dreamteamer) ? pkg.dreamteamer : {}
  function list(key: string) {
    return readOr(issues, file, () => asOptional(dt[key], `dreamteamer.${key}`, asNames) ?? [], [])
  }
  const m: Module = {
    // a module with no name goes by its folder's
    name: readOr(issues, file, () => asOptional(pkg.name, "name", asString), undefined) ?? basename(dir),
    version: readOr(issues, file, () => asOptional(pkg.version, "version", asString), undefined) ?? "0.0.0",
    dir,
    origin,
    title: readOr(issues, file, () => asOptional(dt.title, "dreamteamer.title", asString), undefined),
    namespaces: list("namespaces"),
    dependencies: list("dependencies"),
    peers: list("peer_collections"),
    unsupported: NOT_ACTED_ON.filter((t) => dt[t] !== undefined),
  }
  return m
}
