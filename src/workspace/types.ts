import type { AuthoredDescriptor } from "../types.ts"
/** A source file as parsed — a collection, a ui-view, a module record, a skill's frontmatter: the authored
 *  descriptor keys, all optional, the rest open. Validated by compile, not by this parse. */
export type SourceDoc = Partial<AuthoredDescriptor>

/** A `modules` record's fields (collections/modules.collection.yaml) — projected by compile from package.json. */
export type ModuleFields = {
  name?: string
  title?: string
  description?: string
  namespaces?: string[]
  location?: string
  path?: string
  bin?: string[]
  owns_data?: boolean
  dependencies?: string[]
  peer_collections?: string[]
  collections?: string[]
  [k: string]: unknown
}

export type ModuleRecordRow = { id: string; fields: ModuleFields }

/** What a source write's `after` hook adds to the gate: more files in the commit, and how to put them back. */
export type AfterResult = {
  files?: string[]
  undo?: () => void
  dropped?: string[]
  cleared?: number
  [k: string]: unknown
}

/** A commit failure that already landed in some repos: those commits stand, and the error names them. */
export type CommitError = Error & { commits?: RepoCommit[] }

export type Snapshot = { f: string; prev: Buffer | null }

/**
 * ONE COMMIT PER REPO, in the repo that actually holds each source.
 *
 * ⚠ THE DEFECT THIS FIXES WAS SILENT ABOUT ITS OWN CAUSE. Every schema commit ran at the WORKSPACE
 * root, and `git_modules/` is gitignored there — so `git add -- git_modules/hr/collections/…` added
 * nothing, the pathspec-scoped `git commit` had nothing to record and failed, and the gate rolled
 * the whole op back with a message naming git. A schema write into a git-shape module was therefore
 * impossible, and the reason was invisible: the source compiled, the field was live for one
 * instant, and then the file was restored.
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
export type RepoCommit = { repo: string; sha: string; ahead: number | null }

/** A discovered module, as `discoverModules` reports it. */
export type ModuleSource = { name: string; root: string; channel: string; layer?: string }

/** What `renderTemplate` renders AGAINST, for one workspace: the names `dreamteamer.vars` declares,
 *  the values this machine's `.env` carries, and the root. One builder rather than three lines at
 *  each call site — `dt resolve` and `repos ensure` disagreeing about which vars are declared would
 *  be a path that renders in one verb and refuses in the other. */
export type EnvContext = { env: Map<string, string>; workspaceFolder: string; declared: string[] }
