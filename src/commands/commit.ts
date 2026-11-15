import { openWorkspace } from "../openWorkspace.ts"

export async function run(args: string[]): Promise<number> {
  const ws = await openWorkspace()
  const { commitCommand } = await import("../commitCommand.ts")
  return commitCommand(ws, args)
}
