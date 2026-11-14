import path from "node:path"
import fs from "node:fs"
import type { DreamteamerBlock, PackageJson, Workspace } from "../types.ts"

/** The workspace's own package.json, read → mutate → write. `ws.pkg` is refreshed in place because
 *  `compile({root, pkg})` reads the object it was handed, not the file — a rename that moved
 *  `workspace_module` and did not do this compiled the PREVIOUS layout and failed on a stray-sources
 *  error naming a module that no longer exists. */
export function editWorkspacePkg(ws: Workspace, mutate: (block: DreamteamerBlock, pkg: PackageJson) => void): string {
  const file = path.join(ws.root, "package.json")
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"))
  pkg.dreamteamer ??= {}
  mutate(pkg.dreamteamer, pkg)
  fs.writeFileSync(file, JSON.stringify(pkg, null, "\t") + "\n")
  for (const k of Object.keys(ws.pkg)) delete ws.pkg[k]
  Object.assign(ws.pkg, pkg)
  return file
}
