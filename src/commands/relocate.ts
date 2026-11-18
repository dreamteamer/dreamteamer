import { openWorkspace } from "../openWorkspace.ts"
import { relocateCommand } from "../relocateCommand.ts"

export async function run(args: string[]): Promise<number> {
  const ws = await openWorkspace()
  return relocateCommand(ws, args)
}
