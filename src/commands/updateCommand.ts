import { declaredGitModules } from "../workspace/declaredGitModules.ts"
import { parseUpdateArgs } from "../update/parseUpdateArgs.ts"
import { update } from "../update/update.ts"
import { updateModules } from "../update/updateModules.ts"
import { compile } from "../compile/compile.ts"
import { openWorkspace } from "../openWorkspace.ts"

export async function updateCommand(rest: string[]): Promise<number> {
  const ws = await openWorkspace()
  // an npm module or the engine moves through src/update.js; a git module (or no target) keeps
  // the fast-forward path below
  const u = parseUpdateArgs(rest)
  const gitMods = Object.fromEntries(declaredGitModules(ws.pkg, ws.root).map)
  if (u.engine || (u.name && !gitMods[u.name])) return await updateModules(ws, u, { open: openWorkspace })
  const code = update(ws, u.name)
  compile(ws) // pulled modules may carry new sources — prints its own summary
  return code
}
