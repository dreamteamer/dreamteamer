import { openWorkspace } from "./api.ts"
import { declaredGitModules } from "./record/declaredGitModules.ts"
import type { Workspace } from "./types.ts"
import { parseUpdateArgs } from "./update/parseUpdateArgs.ts"
import { update } from "./update/update.ts"
import { updateModules } from "./update/updateModules.ts"
import { compile } from "./workspace/compile.ts"

export async function updateCommand(ws: Workspace, rest: string[]): Promise<number> {
  // an npm module or the engine moves through src/update.js; a git module (or no target) keeps
  // the fast-forward path below
  const u = parseUpdateArgs(rest)
  const gitMods = Object.fromEntries(declaredGitModules(ws.pkg, ws.root).map)
  if (u.engine || (u.name && !gitMods[u.name])) return await updateModules(ws, u, { open: openWorkspace })
  const code = update(ws, u.name)
  compile(ws) // pulled modules may carry new sources — prints its own summary
  return code
}
