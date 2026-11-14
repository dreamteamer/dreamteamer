import path from "node:path"
import { Store } from "./record/Store.ts"
import { emit } from "./lib/emit.ts"
import { canonicalCollection } from "./record/ref.ts"
import { splitRef } from "./record/splitRef.ts"
import type { Workspace } from "./types.ts"
import { warnIfStale } from "./workspace/compile.ts"

export function relocateCommand(ws: Workspace, rest: string[]): number {
  warnIfStale(ws.root)
  const store = new Store(ws)
  const target = rest.find(a => !a.startsWith("--"))
  if (!target)
    throw new Error("dt relocate needs a target: dreamteamer relocate <collection> | <collection>/<id> [--dry-run]")
  // a collection, or one record of it — the either-shape every other target has
  const asCollection = canonicalCollection(store.descriptors, target)
  const { collection, id } = asCollection ? { collection: asCollection, id: null } : splitRef(store.descriptors, target)
  const out = store.relocate(collection, {
    only: id ? [id] : null,
    dryRun: rest.includes("--dry-run"),
    toRoot: rest.includes("--to-root"),
  })
  if (rest.includes("--json")) {
    emit(JSON.stringify(out, null, 2))
    return out.problems.length ? 1 : 0
  }
  const rel = (p: string): string => path.relative(ws.root, p)
  for (const m of out.moves)
    console.log(`${out.applied ? "✔" : "→"} ${collection}/${m.id}  ${rel(m.from)} → ${rel(m.to)}`)
  for (const p of out.problems) console.error(`✖ ${p}`)
  if (!out.moves.length && !out.problems.length)
    console.log(`nothing to relocate — every ${collection} record is where its descriptor puts it`)
  else if (!out.applied && !out.problems.length)
    console.log(`${out.moves.length} move(s) planned (dry run) — nothing was moved`)
  else if (out.applied)
    console.log(
      `${out.moves.length} record(s) relocated — ids and references unchanged; \`dreamteamer commit ${collection}\` publishes the moves`
    )
  return out.problems.length ? 1 : 0
}
