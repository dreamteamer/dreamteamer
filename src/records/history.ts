import path from "node:path"
import { execFileSync } from "node:child_process"
import { trackedPaths } from "./lib/trackedPaths.ts"
import type { Store } from "../store/Store.ts"
import { storageOf } from "../record/storageOf.ts"
import type { Descriptor } from "../types.ts"

/** A record under an env-pointed root outside the workspace has no repo here, so no past: said in
 *  one sentence rather than as git's "outside repository". */
export function assertInRepo(descriptor: Descriptor, collection: string, id: string): void {
  if (storageOf(descriptor).external)
    throw new Error(
      `${collection}/${id} is kept under ${storageOf(descriptor).path}, outside every git repo here — it has no history`
    )
}

const FORMAT = "%H%x00%an%x00%aI%x00%s"

/**
 * `git log` for a record, newest first. `--follow` (so a rename keeps its past) only applies to a
 * single pathspec — git rejects it outright with several — so a layered record trades it away.
 */
/** The repo a record's file is committed in: a module-owned or layer record's past is in that clone. */
export const repoOf = (store: Store, descriptor: Descriptor, file: string): string =>
  path.resolve(store.root, store.repoOfFile(descriptor, file))

export function history(
  store: Store,
  collection: string,
  id: string
): { hash: string; date: string; author: string; subject: string }[] {
  const { file } = store.read(collection, id),
    descriptor = store.descriptor(collection)
  assertInRepo(descriptor, collection, id)
  const cwd = repoOf(store, descriptor, file)
  const paths = trackedPaths(store, file, cwd)
  const follow = paths.length === 1 ? ["--follow"] : []
  const out = execFileSync("git", ["log", ...follow, `--format=${FORMAT}`, "--", ...paths], { cwd }).toString()
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => {
      const [hash, author, date, subject] = line.split("\0")
      return { hash, author, date, subject }
    })
}
