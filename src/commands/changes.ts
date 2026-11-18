import { openWorkspace } from "../openWorkspace.ts"
import { changesCommand } from "../changes/changesCommand.ts"

export async function run(args: string[]): Promise<number> {
  const ws = await openWorkspace()
  return changesCommand(ws, args)
}
