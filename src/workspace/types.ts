import type { AuthoredDescriptor } from "../types.ts"
/**
 * A source file as parsed — a collection, a ui-view, a module record, a skill's frontmatter: the authored
 * descriptor keys, all optional, the rest open. Validated by compile, not by this parse.
 */
export type SourceDoc = Partial<AuthoredDescriptor>

/** What a source write's `after` hook adds to the gate: more files in the commit, and how to put them back. */
export interface AfterResult {
  files?: string[]
  undo?: () => void
  dropped?: string[]
  cleared?: number
  [k: string]: unknown
}

/** A commit failure that already landed in some repos: those commits stand, and the error names them. */
export interface CommitError extends Error {
  commits?: RepoCommit[]
}

export interface Snapshot {
  f: string
  prev: Buffer | null
}

/**
 * ONE COMMIT PER REPO, in the repo that actually holds each source.
 *
 * A module under modules/<id> may be a repo of its own; a schema write into it must commit THERE,
 * since the workspace root's pathspec-scoped commit would record nothing and roll the op back.
 *
 * `repoRootOf` (compile.js, there since `owns_data` needed it) answers "which repo holds this path"
 * — nearest `.git` at or above it, workspace-relative, `.` for the workspace itself. Grouping by it
 * is the whole fix.
 *
 * Returns `[{repo, sha, ahead}]` so the caller can say WHERE the change landed. `ahead` is the count
 * of commits the repo has that its upstream does not — meaningful only for a clone, and `null` for
 * the workspace, whose publishing story is `git push` like any repo the operator already thinks
 * about.
 *
 * ⚠ ALL-OR-NOTHING ACROSS REPOS IS NOT ACHIEVABLE and is not claimed. Two repos cannot commit
 * atomically. So the FIRST failure aborts, the caller's `undo` restores every source in every repo,
 * and any commit already made is left standing with its own subject — which is honest and
 * inspectable, unlike a partial write with no history. `dt status` then shows the drift. Extending
 * `dt commit` to module sources is the follow-on this file has always named; it is not this wave.
 */
/** One repo's commit of a schema write: its sha, and how far it now runs ahead of its upstream (a clone) */
export interface RepoCommit {
  repo: string
  sha: string
  ahead: number | null
}

/** A discovered module, as `discoverModules` reports it. */
export interface ModuleSource {
  name: string
  root: string
  channel: string
}

/**
 * What `renderTemplate` renders AGAINST, for one workspace: the names `dreamteamer.vars` declares,
 * the values this machine's `.env` carries, and the root. One builder rather than three lines at
 * each call site — `dt resolve` and `repos ensure` disagreeing about which vars are declared would
 * be a path that renders in one verb and refuses in the other.
 */
export interface EnvContext {
  env: Map<string, string>
  workspaceFolder: string
  declared: string[]
}
