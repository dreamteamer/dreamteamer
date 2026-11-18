import { openWorkspace } from "../openWorkspace.ts"
import { resolveCommand } from "../resolveCommand.ts"

export async function run(args: string[]): Promise<number> {
  const ws = await openWorkspace()
  return resolveCommand(ws, args)
}
