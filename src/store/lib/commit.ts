import { storageOf } from "../../record/storageOf.ts"
import path from "node:path"
import type { Store } from "../Store.ts"
import type { Undo } from "../types.ts"

export function commit(store: Store, files: string[], subject: string, undo: Undo | null, repo = "."): void {
  if (!store.autoCommit) return
  // A file under an env-pointed root outside the workspace is outside every repo here BY DESIGN
  // — never handed to git, which would refuse it and roll the write back.
  const outside = (store._outside ??= [...store.descriptors.values()]
    .filter(d => storageOf(d).external)
    .map(d => path.resolve(store.root, storageOf(d).path) + path.sep))
  files = files.filter(f => !outside.some(o => path.resolve(f).startsWith(o)))
  if (!files.length) return
  // ONE COMMIT PER REPO. The record's own repo is `repo`; a file a rename rewrote in another repo
  // belongs to that repo, so the files are grouped by the longest known repo that holds each. A failure in a later group leaves an earlier group's commit standing — the same
  // per-repo truth `dt commit` prints, stated here rather than pretended away.
  // ⚠ A file under NO known clone is the workspace's — never the caller's repo. The fallback used
  // to be `repo`, so renaming a module-owned record that a workspace record named sent the
  // workspace's rewritten `data/tasks/…` to `git add` inside the module clone as `../../data/…`,
  // which git refuses, and the rename rolled back every time auto-commit was on.
  const repos = (store._repos ??= [...new Set([...store.descriptors.values()].map(d => storageOf(d).repo))]
    .filter(r => r !== ".")
    .sort((a, b) => b.length - a.length))
  const repoOf = (f: string): string => {
    const rel = path.relative(store.root, f).split(path.sep).join("/")
    return [...repos, repo].find(r => r !== "." && rel.startsWith(`${r}/`)) ?? "."
  }
  const groups = new Map<string, string[]>()
  for (const f of files) {
    const r = repoOf(f)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r).push(f)
  }
  for (const [r, group] of groups) store._commitIn(path.resolve(store.root, r), group, subject, undo)
}
