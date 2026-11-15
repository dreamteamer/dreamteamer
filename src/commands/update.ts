import { openWorkspace } from "../openWorkspace.ts"

export async function run(args: string[]): Promise<number> {
  const ws = await openWorkspace()
  const { updateCommand } = await import("../update/updateCommand.ts")
  return updateCommand(ws, args, { open: openWorkspace })
}
