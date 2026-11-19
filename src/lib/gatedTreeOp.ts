import type { Store } from "../store/Store.ts"
import type { Workspace } from "../types.ts"
import { commitByRepo } from "../workspace/commitByRepo.ts"
import { compile } from "../compile/compile.ts"
import type { CommitError, RepoCommit } from "../workspace/types.ts"

/**
 * THE GATE FOR AN OP WHOSE MUTATION IS NOT A SET OF FILE WRITES — a folder move, a delete, several
 * package.json edits at once.
 *
 * `writeGated` snapshots BYTES per file, which cannot express any of those: a directory hands
 * `readFileSync` an EISDIR, and a pathspec naming only one file inside a deleted tree commits one
 * deletion and leaves the rest staged-but-uncommitted. So the caller supplies its own `undo` and
 * this owns the ORDER, which is the part that must not be re-derived per op: mutate → compile →
 * commit, and on any failure undo, recompile, rethrow.
 *
 * Same cross-process write lock, same "nothing half-done" contract, same `headMoved()` after a
 * commit. `renameCollection` is the precedent — it has carried its own copy of this block since it
 * needed to move a record folder, and this is that block with the mutation lifted out.
 *
 * `mutate()` may return `{ paths }` to extend the commit pathspec with files it discovered; its
 * return value is what this returns.
 */
export function gatedTreeOp<T extends { paths?: string[] }>(
  ws: Workspace,
  store: Store,
  { subject, paths, mutate, undo }: { subject: string; paths: string[]; mutate: () => T | void; undo: () => void }
): T & { commits: RepoCommit[] } {
  return store.withWriteLock(() => {
    let out: T & { commits?: RepoCommit[] }
    try {
      out = (mutate() ?? {}) as T
      compile(ws) // the gate: an uncompilable change never reaches history
    } catch (e) {
      undo()
      try {
        compile(ws)
      } catch {
        /* pre-op sources were compilable */
      }
      throw e
    }
    // ⚠ NO PATHSPEC FILTER HERE ANY MORE. `commitByRepo` does it per repo, which is the correct
    // place: `isTracked` has to run in the repo that would track the path, and running it at the
    // workspace root answered "no" for every path inside a clone.
    const rels = [...new Set([...paths, ...(out.paths ?? [])])]
    try {
      out.commits = commitByRepo(ws, store, rels, subject)
    } catch (e) {
      undo()
      try {
        compile(ws)
      } catch {
        /* pre-op sources were compilable */
      }
      const landed = ((e as CommitError).commits ?? []).length
        ? ` (${(e as CommitError).commits.map(c => `${c.repo} already committed as ${c.sha}`).join("; ")} — that commit stands)`
        : ""
      throw new Error(
        `git commit failed — ${subject} was rolled back, nothing was changed.${landed} (${e.message.split("\n")[0]})`,
        { cause: e }
      )
    }
    return out as T & { commits: RepoCommit[] }
  })
}
