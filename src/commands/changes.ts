import { openWorkspace } from "../openWorkspace.ts"

export async function run(args: string[]): Promise<number> {
  const ws = await openWorkspace()
  const { changesCommand } = await import("../changes/changesCommand.ts")
  return changesCommand(ws, args)
}
