import { openWorkspace } from "../openWorkspace.ts"
import { commitCommand } from "../commitCommand.ts"

export async function run(args: string[]): Promise<number> {
  const ws = await openWorkspace()
  return commitCommand(ws, args)
}
