import fs from "node:fs"
import path from "node:path"
import type { Store } from "../record/Store.ts"
import type { Workspace } from "../types.ts"
import { assertCommentsKept } from "./assertCommentsKept.ts"
import { commitByRepo } from "./commitByRepo.ts"
import { compile } from "./compile.ts"
import { moduleRows } from "./moduleRows.ts"
import type { AfterResult, CommitError, RepoCommit, Snapshot } from "./types.ts"

export function writeGated(
  ws: Workspace,
  store: Store,
  files: string[],
  subject: string,
  mutate: () => void,
  after?: () => AfterResult,
  { commentsMayDecrease = false }: { commentsMayDecrease?: boolean } = {}
): Required<Pick<AfterResult, "files" | "undo" | "dropped" | "cleared">> &
  AfterResult & { commits: RepoCommit[]; unchanged?: true } {
  // same guarantees as record writes (docs-audit catch): the STORE's cross-process lock
  // serializes schema ops too, and a failed git commit rolls the source back — a schema
  // op fails closed exactly like a record mutation.
  return store.withWriteLock(() => {
    const snapshots: Snapshot[] = files.map((f: string) => ({ f, prev: fs.existsSync(f) ? fs.readFileSync(f) : null }))
    const restore = () => {
      for (const { f, prev } of snapshots) {
        if (prev === null) fs.rmSync(f, { force: true })
        else fs.writeFileSync(f, prev)
      }
    }
    mutate()
    if (!commentsMayDecrease) {
      try {
        assertCommentsKept(ws, snapshots)
      } catch (e) {
        restore()
        throw e
      }
    }
    try {
      compile(ws) // dry-run that doubles as the materialization — throws CompileError on bad sources
    } catch (e) {
      restore()
      try {
        compile(ws)
      } catch {
        /* runtime was already broken before this op */
      }
      // ⚠ THE ROLLBACK IS THE HALF THE OPERATOR CANNOT SEE. compile's sentence is correct and
      // names the missing declaration; what it cannot know is that a verb just undid itself over
      // it. The commonest case by far is an overlay write into a module that does not yet declare
      // its base, so the remedy is spelled as the verb that fixes it — §13. The module names in
      // compile's sentence are PACKAGE names while `dt set modules/<id>` takes an ID; for anything
      // `add modules` created they are the same string, for a forked module they are not.
      const dep = /an overlay of "[^"]+", but module "([^"]+)" neither depends on "([^"]+)"/.exec(e.message)
      if (dep) {
        const idOf = (pkgName: string): string => moduleRows(store).find(r => r.fields.name === pkgName)?.id ?? pkgName
        throw new Error(
          `${e.message}\n  rolled back — dt set modules/${idOf(dep[1])} dependencies=modules/${idOf(dep[2])}, then re-run`,
          { cause: e }
        )
      }
      throw e
    }
    // ⚠ AFTER THE GATE COMPILE, BEFORE THE COMMIT, INSIDE THE LOCK. A schema op that INVALIDATES
    // DATA cleans that data up in the same act — see dropOrphanedMirrors for the case this exists
    // for. It has to run after the compile because it reads the NEW runtime to decide what is
    // residue, and before the commit because a source change and the data repair it forces are one
    // change. It fails the whole op like anything else here: nothing half-done.
    let extra: Required<Pick<AfterResult, "files" | "undo" | "dropped" | "cleared">> & AfterResult = {
      files: [],
      undo: () => {},
      dropped: [],
      cleared: 0,
    }
    if (after) {
      try {
        extra = { ...extra, ...after() }
      } catch (e) {
        restore()
        try {
          compile(ws)
        } catch {
          /* nothing else moved */
        }
        throw e
      }
    }
    // ⚠ A WRITE THAT CHANGED NO BYTES MUST NOT REACH `git commit`. `git commit` on an empty index
    // exits NON-ZERO, so the catch below read a successful no-op as a failed op and reported
    // `✖ git commit failed — the schema change was rolled back` with the raw git command appended,
    // at exit 1 — for `dt set collections/people description=<the value it already has>`, which
    // asked for nothing and got nothing. Every sibling verb already has the graceful spelling
    // ("already named that, nothing to do"), and the documented namespace cleanup path
    // (`dt set modules/<m> namespaces=<ns>` where it is already declared) ran straight into it.
    //
    // Compared as BYTES, after the gate compile: an op whose mutation is a re-serialization can
    // produce an identical file, and "identical" is the only definition of no-op the caller can
    // act on.
    const moved = snapshots.some(({ f, prev }) => {
      const now = fs.existsSync(f) ? fs.readFileSync(f) : null
      return now === null ? prev !== null : prev === null || !now.equals(prev)
    })
    if (!moved && !extra.files.length) return { ...extra, commits: [] as RepoCommit[], unchanged: true as const }
    const rels = [...files, ...extra.files].map(f => path.relative(ws.root, f))
    // Schema ops commit UNCONDITIONALLY — `auto-commit` governs RECORD writes only. A source
    // change is inseparable from the compile that validated it, and `dt commit` scopes itself
    // to record directories, so a deferred source edit would be publishable by nothing.
    // Extending `dt commit` to module sources is the natural follow-on; it is not this wave.
    //
    // ⚠ IN THE REPO THAT HOLDS THE SOURCE, not at the workspace root — see commitByRepo for what
    // running it at the root cost a git-shape module.
    let commits: RepoCommit[]
    try {
      commits = commitByRepo(ws, store, rels, subject)
    } catch (e) {
      extra.undo()
      restore()
      try {
        compile(ws)
      } catch {
        /* pre-op sources were compilable */
      }
      const landed = ((e as CommitError).commits ?? []).length
        ? ` (${(e as CommitError).commits.map(c => `${c.repo} already committed as ${c.sha}`).join("; ")} — that commit stands; two repos cannot commit atomically)`
        : ""
      throw new Error(
        `git commit failed — the schema change was rolled back, nothing was changed.${landed} (${e.message.split("\n")[0]})`,
        { cause: e }
      )
    }
    // The hook's own report, for the caller to print: what a source change did to DATA is not
    // visible in the file list, and a silent data change is a different act from a reported one.
    return { ...extra, commits }
  })
}
