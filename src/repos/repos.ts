import { materializeRepo } from "./materializeRepo.ts"
import { Store } from "../store/Store.ts"
import type { Workspace } from "../types.ts"
import type { RepoFields } from "../workspace/types.ts"

/**
 * dreamteamer repos ensure <id> — materialize ONE declared repo, idempotently.
 * Cheap as a stat when already present, so callers never branch on presence themselves.
 */
export function ensureRepo(ws: Workspace, id: string): { path: string; cloned: boolean } {
  const { fields } = new Store(ws).read("repos", id)
  return materializeRepo(ws, id, fields as RepoFields)
}

/** dreamteamer repos ensure --all — explicit opt-in (going offline, grepping across all of them). */
export function ensureAllRepos(ws: Workspace): { path: string; cloned: boolean }[] {
  const out: { path: string; cloned: boolean }[] = []
  for (const { id, fields } of new Store(ws).readAll("repos")) out.push(materializeRepo(ws, id, fields as RepoFields))
  return out
}
