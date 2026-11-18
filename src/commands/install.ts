import { installCommand } from "../install/installCommand.ts"
import { openWorkspace } from "../openWorkspace.ts"
import { targetCommand } from "../targetCommand.ts"
import { verify } from "./lib/verify.ts"

export async function run(args: string[]): Promise<number> {
  const ws = await openWorkspace()
  return installCommand(ws, args, {
    open: openWorkspace,
    verify,
    ensureRepos: a => targetCommand(ws, "repos", "ensure", a),
  })
}
