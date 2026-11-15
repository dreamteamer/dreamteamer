import { openWorkspace } from "../openWorkspace.ts"

export async function run(args: string[]): Promise<number> {
  const ws = await openWorkspace()
  const [{ runExports }, { Store }] = await Promise.all([
    import("../exports/runExports.ts"),
    import("../store/Store.ts"),
  ])
  const layers = args
    .flatMap((a, i) => (a === "--layer" ? [args[i + 1]] : a.startsWith("--layer=") ? [a.slice(8)] : []))
    .filter(Boolean)
  return runExports(new Store(ws), { layers, dryRun: args.includes("--dry-run"), json: args.includes("--json") })
}
