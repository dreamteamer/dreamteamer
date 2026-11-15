import { openWorkspace } from "../openWorkspace.ts"
import { verify } from "./lib/verify.ts"

export async function run(args: string[]): Promise<number> {
  const ws = await openWorkspace()
  const [{ installCommand }, { targetCommand }] = await Promise.all([
    import("../install/installCommand.ts"),
    import("../targetCommand.ts"),
  ])
  return installCommand(ws, args, {
    open: openWorkspace,
    verify,
    ensureRepos: a => targetCommand(ws, "repos", "ensure", a),
  })
}
