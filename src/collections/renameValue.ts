import fs from "node:fs"
import path from "node:path"
import { applyRewrites } from "./applyRewrites.ts"
import { gatedTreeOp } from "./gatedTreeOp.ts"
import { renameValuePlan } from "./renameValuePlan.ts"
import { refusePositions } from "./schema-ops.ts"
import { valueRenameWalk } from "./valueRenameWalk.ts"
import type { Store } from "../record/Store.ts"
import type { Workspace } from "../types.ts"

export function renameValue(
  ws: Workspace,
  store: Store,
  collection: string,
  field: string,
  from: string,
  to: string | true | undefined,
  { dryRun = false }: { dryRun?: boolean } = {}
) {
  const plan = renameValuePlan(ws, store, collection, field, from, to)
  if (dryRun) return { ...plan, renamed: false, dryRun: true }
  refusePositions(`rename-value ${collection} ${field} ${from} → ${to}`, plan.positions)
  const d = store.descriptor(collection)
  const snapshots = new Map<string, Buffer>()
  const snap = (f: string): void => {
    if (!snapshots.has(f)) snapshots.set(f, fs.readFileSync(f))
  }
  const out = gatedTreeOp(ws, store, {
    subject: `dreamteamer: ${collection} rename-value ${field} ${from} → ${to}`,
    paths: [],
    mutate: () => {
      const walked = valueRenameWalk(ws, store, collection, field, from, to as string)
      refusePositions(`rename-value ${collection} ${field} ${from} → ${to}`, walked.positions)
      return { paths: [...applyRewrites(ws, walked.edits, walked.records, d, snap)] }
    },
    undo: () => {
      for (const [f, bytes] of snapshots) {
        fs.mkdirSync(path.dirname(f), { recursive: true })
        fs.writeFileSync(f, bytes)
      }
    },
  })
  return { ...plan, renamed: true, commits: out.commits }
}
