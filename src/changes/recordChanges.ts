import { CHANGE_OF, TYPE_OF } from "./consts.ts"
import { deriveEvents } from "./deriveEvents.ts"
import type { Store } from "../record/Store.ts"
import { commitPending } from "../record/commitPending.ts"
import { foldChanges } from "../record/foldChanges.ts"
import { layerOf } from "../record/layerOf.ts"
import { rowChanges } from "../record/rowChanges.ts"
import type { RecordChange } from "../record/types.ts"

/** `dt changes`: the records changed since `since`, across every repo that holds records. `HEAD` (the
 *  default) is the UNCOMMITTED state, each repo against its own HEAD — sampled by the same dry run
 *  `dt status` counts with, so the two can never disagree. Any other `since` (a sha or a date) adds
 *  the commits since then, read by `deriveEvents`, and folds the two per record. Stateless: no mark
 *  file and no cursor, so it is free to run twice and cannot drift from git. */
export function recordChanges(store: Store, { since = "HEAD" }: { since?: string } = {}) {
  const pending: RecordChange[] = []
  for (const r of commitPending(store, { dryRun: true }))
    if (!r.outside) pending.push(...rowChanges(store.descriptors, r.repo, r.rows))
  const committed =
    since === "HEAD"
      ? []
      : deriveEvents(store.root, store.descriptors, since).map((e): RecordChange => ({
          collection: e.collection,
          id: e.id,
          ref: `${e.collection}/${e.id}`,
          path: e.path,
          repo: e.repo,
          layer: layerOf(store.descriptors, e.repo),
          change: CHANGE_OF[e.type],
        }))
  // `type` is the 0.41.0 spelling of `change`, kept so a reader of the old JSON keeps working
  return foldChanges(committed, pending).map(c => ({ ...c, type: TYPE_OF[c.change] }))
}
