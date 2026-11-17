import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { asObject } from "../lib/asObject.ts"

/**
 * The released engine's `init`, as far as a workspace needs it to be read here: a `dreamteamer` block in package.json
 * (its `workspace_module` is `default`), that module's folder and package.json, and the data folder. Writes only what
 * is absent; never commits. Review: no starter collection, .gitignore, .env.example or editor recommendation.
 */
export function init(root: string): number {
  const file = join(root, "package.json")
  const pkg = existsSync(file)
    ? asObject(JSON.parse(readFileSync(file, "utf8")), "package.json")
    : { name: basename(root), private: true, version: "0.0.1" }
  if (!("dreamteamer" in pkg)) {
    Object.assign(pkg, { dreamteamer: { data_path: "data", workspace_module: "default" } })
    writeFileSync(file, JSON.stringify(pkg, null, "\t") + "\n")
  }
  const own = join(root, "modules", "default")
  mkdirSync(own, { recursive: true })
  mkdirSync(join(root, "data"), { recursive: true })
  const manifest = { name: "default", private: true, version: "0.0.1", dreamteamer: {} }
  if (!existsSync(join(own, "package.json")))
    writeFileSync(join(own, "package.json"), JSON.stringify(manifest, null, "\t") + "\n")
  console.log(`✔ workspace ${basename(root)} initialized`)
  return 0
}
