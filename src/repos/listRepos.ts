import fs from "node:fs"
import { Store } from "../store/Store.ts"
import type { Workspace } from "../types.ts"
import { relPath } from "./lib/relPath.ts"
import { repoPath } from "./lib/repoPath.ts"
import type { RepoFields } from "./types.ts"

/**
 * Declared repos and whether each is on disk. Presence is OBSERVED, never stored on the record —
 * with lazy materialization "is it here?" is the first question anyone asks, and a stored answer
 * would be wrong the moment someone deletes a folder.
 */
export function listRepos(ws: Workspace): { id: string; path: string; present: boolean; unresolved?: string }[] {
  const out: ReturnType<typeof listRepos> = []
  for (const { id, fields } of new Store(ws).readAll("repos")) {
    // A path this machine cannot render is ONE unusable repo, not an unusable listing: `status`
    // asks this for every record, and a workspace cloned onto a machine that lacks one `.env` key
    // would otherwise report nothing about any of them. Say which, and why.
    let dest: string
    const f = fields as RepoFields
    try {
      dest = repoPath(ws, f)
    } catch (e) {
      out.push({ id, path: f.path ?? f.name, present: false, unresolved: e.message })
      continue
    }
    out.push({ id, path: relPath(ws.root, dest), present: fs.existsSync(dest) })
  }
  return out
}
