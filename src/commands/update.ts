import { openWorkspace } from "../openWorkspace.ts"
import { updateCommand } from "../update/updateCommand.ts"

export async function run(args: string[]): Promise<number> {
  const ws = await openWorkspace()
  return updateCommand(ws, args, { open: openWorkspace })
}
