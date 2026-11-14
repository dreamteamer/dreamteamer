import path from "node:path"
import fs from "node:fs"
import { execFileSync } from "node:child_process"
import type { Store } from "../record/Store.ts"
import type { Workspace } from "../types.ts"
import { GIT_QUIET } from "./consts.ts"
import { aheadCount } from "./aheadCount.ts"
import { isTracked } from "./isTracked.ts"
import { repoRootOf } from "./repoRootOf.ts"
import { shortHead } from "./shortHead.ts"
import type { RepoCommit } from "./types.ts"

export function commitByRepo(ws: Workspace, store: Store, rels: string[], subject: string): RepoCommit[] {
  const byRepo = new Map<string, { root: string; paths: string[] }>() // workspace-relative repo root -> {root, paths relative to THAT repo}
  for (const rel of new Set(rels)) {
    const abs = path.join(ws.root, rel)
    // A path that is neither on disk nor in any index cannot be a pathspec, and one bad entry
    // aborts the whole `git add` — the lesson `renameCollection` paid for. ⚠ The filter runs PER
    // REPO: `isTracked` has to run in the repo that would track the path, and running it at the
    // workspace root answered "no" for every path inside a clone.
    const repo = repoRootOf(path.dirname(abs), ws.root)
    const repoAbs = repo === "." ? ws.root : path.join(ws.root, repo)
    const inRepo = path.relative(repoAbs, abs)
    if (!fs.existsSync(abs) && !isTracked(repoAbs, inRepo)) continue
    if (!byRepo.has(repo)) byRepo.set(repo, { root: repoAbs, paths: [] })
    byRepo.get(repo).paths.push(inRepo)
  }
  const out: RepoCommit[] = []
  try {
    for (const [repo, { root, paths }] of byRepo) {
      execFileSync("git", ["add", "--all", "--", ...paths], { cwd: root, stdio: GIT_QUIET })
      execFileSync("git", ["commit", "--quiet", "-m", subject, "--", ...paths], { cwd: root, stdio: GIT_QUIET })
      out.push({ repo, sha: shortHead(root), ahead: repo === "." ? null : aheadCount(root) })
    }
  } catch (e) {
    // unstage everything this call touched, in every repo, before handing the failure back
    for (const [, { root, paths }] of byRepo) {
      try {
        execFileSync("git", ["reset", "--quiet", "--", ...paths], { cwd: root, stdio: GIT_QUIET })
      } catch {
        /* nothing staged */
      }
    }
    e.commits = out // what DID land, for the caller's message
    throw e
  } finally {
    store.headMoved() // this ran `git commit` — see store.gitHead
  }
  return out
}
