import { runExports } from "../exports/runExports.ts"
import { openWorkspace } from "../openWorkspace.ts"
import { Store } from "../store/Store.ts"

export async function run(args: string[]): Promise<number> {
  const ws = await openWorkspace()
  const layers = args
    .flatMap((a, i) => (a === "--layer" ? [args[i + 1]] : a.startsWith("--layer=") ? [a.slice(8)] : []))
    .filter(Boolean)
  return runExports(new Store(ws), { layers, dryRun: args.includes("--dry-run"), json: args.includes("--json") })
}
