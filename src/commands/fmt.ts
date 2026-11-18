import { openWorkspace } from "../openWorkspace.ts"
import { fmtCommand } from "../fmt/fmtCommand.ts"

export async function run(args: string[]): Promise<number> {
  const ws = await openWorkspace()
  return fmtCommand(ws, args)
}
