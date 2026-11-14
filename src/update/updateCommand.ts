import { declaredGitModules } from "../workspace/declaredGitModules.ts"
import type { Workspace } from "../types.ts"
import { parseUpdateArgs } from "./parseUpdateArgs.ts"
import { update } from "./update.ts"
import { updateModules } from "./updateModules.ts"
import { compile } from "../compile/compile.ts"

/** `open` is handed in by the CLI — an opener with the extensions activated — so this folder imports
 *  no entry point. */
export async function updateCommand(
  ws: Workspace,
  rest: string[],
  { open }: { open: (at: string) => Promise<Workspace> }
): Promise<number> {
  // an npm module or the engine moves through src/update.js; a git module (or no target) keeps
  // the fast-forward path below
  const u = parseUpdateArgs(rest)
  const gitMods = Object.fromEntries(declaredGitModules(ws.pkg, ws.root).map)
  if (u.engine || (u.name && !gitMods[u.name])) return await updateModules(ws, u, { open })
  const code = update(ws, u.name)
  compile(ws) // pulled modules may carry new sources — prints its own summary
  return code
}
