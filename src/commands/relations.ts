import { warnIfStale } from "../compile/warnIfStale.ts"
import { openWorkspace } from "../openWorkspace.ts"
import { relationsCommand } from "../relationsCommand.ts"

/** Reads the compiled relations, so it gets the same staleness warning every record verb gets. */
export async function run(args: string[]): Promise<number> {
  const ws = await openWorkspace()
  warnIfStale(ws.root)
  return relationsCommand(ws, args)
}
