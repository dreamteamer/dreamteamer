import { relative } from "node:path"
import { commitArg, git } from "./git.ts"
import type { Store } from "./Store.ts"

/** the file git has a past for: a data record's own, a source kind's source file */
function tracked(store: Store, collection: string, id: string) {
  const file = store.model.sources[collection]?.[id] ?? store.read(collection, id).file
  return relative(store.root, file).split("\\").join("/")
}

/** a record's commits, newest first, following a rename */
export function history(store: Store, collection: string, id: string) {
  const out = git(store.root, [
    "log",
    "--follow",
    "--format=%H%x00%an%x00%aI%x00%s",
    "--",
    tracked(store, collection, id),
  ])
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, author, date, subject] = line.split("\0")
      const res = { hash, author, date, subject }
      return res
    })
}

/** the patch one commit applied to a record; a root commit's too, which the released engine refuses */
export function historyDiff(store: Store, collection: string, id: string, hash: unknown = "HEAD") {
  const rev = commitArg(hash)
  const path = tracked(store, collection, id)
  const res = { hash: rev, path, diff: git(store.root, ["show", "--format=", "--end-of-options", rev, "--", path]) }
  return res
}
