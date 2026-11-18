import { formatDescriptors } from "../fmt/formatDescriptors.ts"
import { Store } from "../store/Store.ts"
import { canonicalCollection } from "../record/ref.ts"
import { reportCommits } from "../workspace/reportCommits.ts"
import { openWorkspace } from "../openWorkspace.ts"

export async function fmtCommand(rest: string[]): Promise<number> {
  const ws = await openWorkspace()
  const target = rest.find(a => !a.startsWith("--"))
  let collection = target ?? null
  try {
    if (target) collection = canonicalCollection(new Store(ws).descriptors, target) ?? target
  } catch {
    /* no runtime: the name as typed */
  }
  const dryRun = rest.includes("--dry-run")
  const out = formatDescriptors(ws, { collection, dryRun })
  for (const f of out.changed) console.log(`${dryRun ? "→" : "✔"} ${f}`)
  const under = (dir: string): number => out.skipped.filter(f => f.startsWith(`${dir}/`)).length
  if (out.skipped.length)
    console.log(
      `— skipped ${under("git_modules")} source(s) under git_modules/ and ${under("node_modules")} under node_modules/ — format those in their own repo`
    )
  console.log(
    `${out.changed.length} source(s) ${dryRun ? "would change (dry run — nothing was written)" : "formatted"}, ${out.unchanged} already canonical`
  )
  reportCommits(out.commits)
  return 0
}
