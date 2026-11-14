import type { Workspace, Flags } from "../types.ts"
import { ensureAllRepos, ensureRepo } from "./repos.ts"
import { need } from "../lib/need.ts"
import { emit } from "../lib/emit.ts"
import { Store } from "../store/Store.ts"

/**
 * `repos ensure <id>` / `repos ensure --all` — materialize declared repos on demand.
 * Lazy by design: `install` deliberately does NOT do this, so a fresh workspace clone is
 * immediately workable without pulling every attached repo (and one unreachable remote can only
 * fail the action you asked for, not the whole install).
 */
function metaReposEnsure(ws: Workspace, flags: Flags, pos: string[]) {
  const results = flags.all ? ensureAllRepos(ws) : [ensureRepo(ws, need(pos, 0, "id"))]
  if (flags.json) {
    emit(JSON.stringify(results, null, 2))
    return 0
  }
  for (const r of results) console.log(r.cloned ? `✔ cloned ${r.path}` : `✔ ${r.path} (present)`)
  if (!results.length) console.log("(no repos declared)")
  return 0
}

/** `dt install repos/<id>` — reached as `repos ensure` — or null for any other verb. */
export function reposCommand(
  ws: Workspace,
  store: Store,
  collection: string,
  verb: string,
  flags: Flags,
  pos: string[]
): number | null {
  if (collection === "repos" && verb === "ensure") return metaReposEnsure(ws, flags, pos)
  return null
}
