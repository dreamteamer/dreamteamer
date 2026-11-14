import fs from "node:fs"
import path from "node:path"
import { applyRewrites } from "./lib/applyRewrites.ts"
import { fieldRenameWalk } from "./lib/fieldRenameWalk.ts"
import { gatedTreeOp } from "../lib/gatedTreeOp.ts"
import { renameFieldPlan } from "./lib/renameFieldPlan.ts"
import { refusePositions } from "../lib/schema-ops.ts"
import { INJECTED } from "./lib/consts.ts"
import type { Store } from "../store/Store.ts"
import { fieldsOf } from "../record/descriptor.ts"
import type { Workspace } from "../types.ts"

export function renameField(
  ws: Workspace,
  store: Store,
  collection: string,
  from: string,
  to: string | true | undefined,
  { dryRun = false }: { dryRun?: boolean } = {}
) {
  const d = store.descriptor(collection)
  if (!to || to === true)
    throw new Error(`missing --to <new-name>: dreamteamer rename-field ${collection} --name ${from} --to <new-name>`)
  if (from === to) return { renamed: false, collection, from, to }
  const fields = fieldsOf(d)
  if (!fields[from]) throw new Error(`no field "${from}" on ${collection}`)
  if (INJECTED.has(from))
    throw new Error(`"${from}" is injected by the engine into every collection — it cannot be renamed`)
  if (fields[to] || INJECTED.has(to))
    throw new Error(
      `${collection} already has a field "${to}" — pick another name, or remove it first (dreamteamer rm-field ${collection} --name ${to}).`
    )
  const plan = renameFieldPlan(ws, store, collection, from, to)
  if (dryRun) return { ...plan, renamed: false, dryRun: true }
  refusePositions(`rename-field ${collection} ${from} → ${to}`, plan.positions)

  const snapshots = new Map<string, Buffer>()
  const snap = (f: string): void => {
    if (!snapshots.has(f)) snapshots.set(f, fs.readFileSync(f))
  }
  const out = gatedTreeOp(ws, store, {
    subject: `dreamteamer: ${collection} rename-field ${from} → ${to}`,
    paths: [],
    mutate: () => {
      // walked again INSIDE the lock, so what is written is what is on disk now
      const walked = fieldRenameWalk(ws, store, collection, from, to)
      refusePositions(`rename-field ${collection} ${from} → ${to}`, walked.positions)
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
