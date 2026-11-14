// per-record revision history, straight out of git.
//
// Extracted because it had drifted into being UI-only in practice: the exact same `git log
// --follow --format=…` and `git diff <hash>~1 <hash>` lived inlined in `server.js`'s routes AND
// copy-pasted into the VS Code extension's `src/api.ts`, with no CLI verb anywhere — so "show me
// how this record changed" was a thing you could do by clicking and not by asking an agent. One
// implementation here, three callers (CLI, server, extension).
import { execFileSync } from "node:child_process"
import path from "node:path"
import { RUNTIME_DIR, readManifest } from "./runtime.ts"
import { storageOf } from "./descriptor.ts"
import type { Store } from "./store.ts"
import type { Descriptor } from "./types.ts"

/** A record under an env-pointed root outside the workspace has no repo here, so no past: said in
 *  one sentence rather than as git's "outside repository". */
function assertInRepo(descriptor: Descriptor, collection: string, id: string): void {
  if (storageOf(descriptor).external)
    throw new Error(
      `${collection}/${id} is kept under ${storageOf(descriptor).path}, outside every git repo here — it has no history`
    )
}

const FORMAT = "%H%x00%an%x00%aI%x00%s"

/** A revision a caller hands to git: a commit id (4 to 40 hex digits) or HEAD — with `relative`,
 *  also `HEAD~<n>`, the spelling `dt changes --since` documents. git reads a revision that starts
 *  with a dash as an option, and some options write files, so anything else is refused before git
 *  runs; the argv still puts it after `--end-of-options`. */
const COMMIT = /^(?:HEAD|[0-9a-fA-F]{4,40})$/
const RELATIVE = /^(?:HEAD(?:~\d+)?|[0-9a-fA-F]{4,40})$/
export function commitArg(rev: unknown, relative = false): string {
  if (typeof rev !== "string" || !(relative ? RELATIVE : COMMIT).test(rev))
    throw new Error(`${JSON.stringify(rev)} is not a commit id — give a commit hash (4 to 40 hex digits) or HEAD`)
  return rev
}

/**
 * The TRACKED file(s) behind a record — what git actually has commits for.
 *
 * For an ordinary data record that is the record itself. For a SYSTEM-stored one (collections,
 * ui-views, skills, agents…) `store.read` hands back the compiled artifact under `.dreamteamer/`,
 * which is gitignored — asking git about it returns nothing, so history silently reported "no
 * history" for every schema and view record. The manifest already maps each runtime entry back to
 * the source(s) that produced it; those are the files with a past.
 *
 * A layered record (a workspace module overriding a module-shipped one) has SEVERAL sources and
 * genuinely changes when any of them does, so all of them are followed.
 */
function trackedPaths(store: Store, file: string, cwd: string): string[] {
  const rel = path.relative(store.root, file).split(path.sep).join("/") // git pathspecs take `/` on every OS
  if (!rel.startsWith(`${RUNTIME_DIR}/`)) return [path.relative(cwd, file).split(path.sep).join("/")]
  try {
    const key = rel.split("/").slice(1).join("/") // drop the `.dreamteamer/` prefix
    const sources = readManifest(store.root)?.entries?.[key]?.sources ?? []
    const paths = sources.map((s: string | { path: string }) => (typeof s === "string" ? s : s?.path)).filter(Boolean)
    return paths.length ? paths : [rel]
  } catch {
    return [rel] // no manifest (never compiled) — nothing better to offer
  }
}

/**
 * `git log` for a record, newest first. `--follow` (so a rename keeps its past) only applies to a
 * single pathspec — git rejects it outright with several — so a layered record trades it away.
 */
/** The repo a record's file is committed in: a module-owned or layer record's past is in that clone. */
const repoOf = (store: Store, descriptor: Descriptor, file: string): string =>
  path.resolve(store.root, store.repoOfFile(descriptor, file))

export function history(
  store: Store,
  collection: string,
  id: string
): { hash: string; date: string; author: string; subject: string }[] {
  const { file } = store.read(collection, id),
    descriptor = store.descriptor(collection)
  assertInRepo(descriptor, collection, id)
  const cwd = repoOf(store, descriptor, file)
  const paths = trackedPaths(store, file, cwd)
  const follow = paths.length === 1 ? ["--follow"] : []
  const out = execFileSync("git", ["log", ...follow, `--format=${FORMAT}`, "--", ...paths], { cwd }).toString()
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => {
      const [hash, author, date, subject] = line.split("\0")
      return { hash, author, date, subject }
    })
}

/** The patch one revision applied to this record. `hash~1` means the ROOT commit has no diff. */
export function historyDiff(
  store: Store,
  collection: string,
  id: string,
  hash = "HEAD"
): { hash: string; path: string; diff: string } {
  commitArg(hash)
  const { file } = store.read(collection, id),
    descriptor = store.descriptor(collection)
  assertInRepo(descriptor, collection, id)
  const cwd = repoOf(store, descriptor, file)
  const paths = trackedPaths(store, file, cwd)
  const diff = execFileSync("git", ["diff", "--end-of-options", `${hash}~1`, hash, "--", ...paths], { cwd }).toString()
  return { hash, path: paths.join(", "), diff }
}
