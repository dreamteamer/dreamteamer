import { execFileSync } from "node:child_process"
import { assertInRepo, repoOf } from "./history.ts"
import { trackedPaths } from "./lib/trackedPaths.ts"
import type { Store } from "../record/Store.ts"
import { commitArg } from "../lib/git/commitArg.ts"

/** The patch one revision applied to this record. `hash~1` means the ROOT commit has no diff. */
export function historyDiff(
  store: Store,
  collection: string,
  id: string,
  hash = "HEAD"
): { hash: string; path: string; diff: string } {
  commitArg(hash)
  const { file } = store.read(collection, id),
    descriptor = store.descriptor(collection)
  assertInRepo(descriptor, collection, id)
  const cwd = repoOf(store, descriptor, file)
  const paths = trackedPaths(store, file, cwd)
  const diff = execFileSync("git", ["diff", "--end-of-options", `${hash}~1`, hash, "--", ...paths], { cwd }).toString()
  return { hash, path: paths.join(", "), diff }
}
