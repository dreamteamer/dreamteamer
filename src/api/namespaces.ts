import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { asOptional } from "../lib/asOptional.ts"
import { asNames } from "../lib/asNames.ts"
import { mapOf } from "../lib/mapOf.ts"
import type { Model } from "../types/Model.ts"

/** the namespaces the workspace's package.json declares (`dreamteamer.namespaces`) */
function declared(root: string): string[] {
  const file = join(root, "package.json")
  if (!existsSync(file)) return []
  const config = mapOf(mapOf(JSON.parse(readFileSync(file, "utf8"))).dreamteamer)
  return asOptional(config.namespaces, "package.json dreamteamer.namespaces", asNames) ?? []
}

/** every namespace the workspace and its modules declare, longest first, so a reference splits at the longest */
export function namespacesOf(model: Model): string[] {
  const all = new Set([...declared(model.root), ...model.modules.flatMap((t) => t.namespaces)])
  return [...all].sort((x, y) => y.length - x.length || x.localeCompare(y))
}
