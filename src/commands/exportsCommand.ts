import { runExports } from "../exports/runExports.ts"
import { openWorkspace } from "../openWorkspace.ts"
import { Store } from "../store/Store.ts"

export async function exportsCommand(args: string[]): Promise<number> {
  const ws = await openWorkspace()
  return runExports(new Store(ws), { dryRun: args.includes("--dry-run"), json: args.includes("--json") })
}
