import { existsSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { activate } from "../extensions/activate.ts"
import { DtError } from "../lib/DtError.ts"
import { isObject } from "../lib/isObject.ts"
import { buildModel } from "../model/buildModel.ts"

/** the package.json of a folder when it is a workspace's (it has a `dreamteamer` key), else null */
function manifestOf(dir: string): Record<string, unknown> | null {
  const file = join(dir, "package.json")
  if (!existsSync(file)) return null
  try {
    const pkg: unknown = JSON.parse(readFileSync(file, "utf8"))
    return isObject(pkg) && "dreamteamer" in pkg ? pkg : null
  } catch {
    return null
  }
}

/**
 * The workspace a folder is in: the folder a caller pinned (`Symbol.for("dreamteamer.workspace")`, as the released
 * engine honours it), else the nearest folder at or above `start` whose package.json has a `dreamteamer` key — climbing
 * out of a module that sits in a workspace's `modules/` or `node_modules/`, as the released engine does.
 */
export function findWorkspace(start = process.cwd()) {
  const pinned: unknown = Reflect.get(globalThis, Symbol.for("dreamteamer.workspace"))
  let found: { root: string; pkg: Record<string, unknown> } | null = null
  for (let dir = typeof pinned === "string" ? pinned : resolve(start); ; dir = dirname(dir)) {
    if (found && typeof pinned === "string") break
    const pkg = manifestOf(dir)
    const inside = (t: string) => found && relative(join(dir, t), found.root).match(/^[^.][^/]*(\/[^/]+)?$/)
    if (pkg && (!found || inside("modules") || inside("node_modules"))) found = { root: dir, pkg }
    else if (pkg || typeof pinned === "string") break
    if (dirname(dir) === dir) break
  }
  if (!found)
    throw new DtError('not a dreamteamer workspace — no package.json with a "dreamteamer" section here or above')
  return found
}

/** the workspace at or above a folder, with the extensions its modules declare activated against this API */
export async function openWorkspace(start?: string) {
  return activate(buildModel(findWorkspace(start).root))
}
