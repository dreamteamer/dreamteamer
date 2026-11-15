import { openWorkspace } from "../openWorkspace.ts"

export async function run(args: string[]): Promise<number> {
  const ws = await openWorkspace()
  const { fmtCommand } = await import("../fmt/fmtCommand.ts")
  return fmtCommand(ws, args)
}
