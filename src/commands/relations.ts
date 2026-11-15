import { openWorkspace } from "../openWorkspace.ts"

/** Reads the compiled relations, so it gets the same staleness warning every record verb gets. */
export async function run(args: string[]): Promise<number> {
  const ws = await openWorkspace()
  const [{ warnIfStale }, { relationsCommand }] = await Promise.all([
    import("../compile/warnIfStale.ts"),
    import("../relationsCommand.ts"),
  ])
  warnIfStale(ws.root)
  return relationsCommand(ws, args)
}
