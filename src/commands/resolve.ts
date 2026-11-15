import { openWorkspace } from "../openWorkspace.ts"

export async function run(args: string[]): Promise<number> {
  const ws = await openWorkspace()
  const { resolveCommand } = await import("../resolveCommand.ts")
  return resolveCommand(ws, args)
}
