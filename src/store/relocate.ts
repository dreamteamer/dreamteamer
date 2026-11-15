import path from "node:path"
import { storageOf } from "../record/storageOf.ts"
import { execFileSync } from "node:child_process"
import { QUIET } from "../lib/consts.ts"
import type { Store } from "./Store.ts"
import type { RelocatePlan, Undo } from "./types.ts"

export function relocate(
  store: Store,
  collection: string,
  { only = null, dryRun = false, toRoot = false }: { only?: string[] | null; dryRun?: boolean; toRoot?: boolean } = {}
): RelocatePlan<"placement" | "shape" | "to-root"> & { applied: boolean } {
  const d = store.writableDescriptor(collection)
  const planned = store.relocatePlan(collection, only, { toRoot })
  // problems FIRST, moves or not: a plan with a dangling owner in it is refused whole, and a dry run
  // of it reports the problem rather than the empty success it would otherwise read as
  if (planned.problems.length && !dryRun)
    throw new Error(`relocate refused:\n  ${planned.problems.join("\n  ")}\nnothing was moved.`)
  if (dryRun || !planned.moves.length) return { ...planned, applied: false }
  const cwd = path.resolve(store.root, storageOf(d).repo)
  const sources = planned.moves.map(m => path.relative(cwd, m.from))
  let dirty = ""
  try {
    dirty = execFileSync("git", ["status", "--porcelain", "--", ...sources], { cwd, stdio: QUIET })
      .toString()
      .trim()
  } catch {
    /* not a git repo — nothing to protect */
  }
  if (dirty)
    throw new Error(
      `relocate refused — these records have unpublished changes, and a move on top of them would hide the edit under the move:\n${dirty
        .split("\n")
        .map(l => `  ${l}`)
        .join("\n")}\nrun \`dreamteamer commit ${collection}\` first. nothing was moved.`
    )
  return store.withWriteLock(() => {
    store._idsCache.delete(collection)
    store._dropPlacedUnder(collection)
    const undos: Undo[] = []
    const rollback = () => {
      for (const u of [...undos].reverse()) u()
      store._idsCache.delete(collection)
      store._dropPlacedUnder(collection)
    }
    try {
      for (const m of planned.moves) undos.push(store._moveRecord(d, m.from, m.to))
    } catch (e) {
      rollback()
      throw e
    }
    const files = planned.moves.flatMap(m => [m.from, m.to])
    store.commit(
      files,
      `dreamteamer: ${collection} relocate ${planned.moves.length} record(s)${toRoot ? " to root" : ""}`,
      rollback,
      storageOf(d).repo
    )
    return { ...planned, applied: true }
  })
}
