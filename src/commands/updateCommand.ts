import { parseUpdateArgs } from "../update/parseUpdateArgs.ts"
import { updateModules } from "../update/updateModules.ts"
import { openWorkspace } from "../openWorkspace.ts"

export async function updateCommand(rest: string[]): Promise<number> {
  const ws = await openWorkspace()
  const u = parseUpdateArgs(rest)
  if (!u.engine && !u.name)
    throw new Error("dt update needs a target — <name>[@<version>] moves one module's pin, --engine the engine's")
  return await updateModules(ws, u, { open: openWorkspace })
}
