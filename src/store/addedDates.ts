import { storageOf } from "../record/storageOf.ts"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { gitDateToStamp } from "./lib/gitDateToStamp.ts"
import type { Store } from "./Store.ts"

export function addedDates(store: Store, collection: string): Map<string, string> {
  store._addedDates ??= new Map()
  if (store._addedDates.has(collection)) return store._addedDates.get(collection)
  const dates = new Map()
  const s = storageOf(store.descriptor(collection))
  // one `git log` in the repo the collection sits in
  {
    const repo = path.resolve(store.root, s.repo ?? ".")
    const inRepo = (p: string): string => path.relative(repo, path.resolve(store.root, p)).split(path.sep).join("/")
    // every place a record of this collection can sit: its own folder, and — when it is stored under a
    // parent — each parent record's subfolder, so a move between the two is seen as the rename it is
    const where = [inRepo(s.path)]
    if (s.under?.collection && s.under.subfolder)
      where.push(`:(glob)${inRepo(storageOf(store.descriptor(s.under.collection)).path)}/**/${s.under.subfolder}/**`)
    try {
      const out = execFileSync(
        "git",
        ["log", "--reverse", "-M", "--diff-filter=AR", "--name-status", "--format=%x01%aI", "--", ...where],
        { cwd: repo, stdio: ["ignore", "pipe", "ignore"], timeout: 60_000, maxBuffer: 256 * 1024 * 1024 }
      ).toString()
      const key = (p: string): string => path.relative(store.root, path.join(repo, p)).split(path.sep).join("/")
      let at
      for (const line of out.split("\n")) {
        if (line.startsWith("\x01")) {
          at = gitDateToStamp(line.slice(1))
          continue
        }
        const [status, a, b] = line.split("\t")
        if (status === "A" && !dates.has(key(a))) dates.set(key(a), at)
        else if (status?.startsWith("R") && b) {
          dates.set(key(b), dates.get(key(a)) ?? at)
          dates.delete(key(a))
        }
      }
    } catch {
      /* no git, or no history yet: every date stays unknown */
    }
  }
  store._addedDates.set(collection, dates)
  return dates
}
