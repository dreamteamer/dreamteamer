import type {
  AuthoredDescriptor,
  Descriptor,
  Field,
  HarnessContext,
  PackageJson,
  SetupAction,
  SetupCheck,
  SetupInput,
  SetupUnit,
} from "../types.ts"

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

/**
 * Where a declared repo's working tree lives. Materializes nothing, so callers can ask without
 * cloning (that is how `status` reports presence).
 *
 * The engine deliberately does NOT know what `identity` means: a workspace may use it to select a
 * `~/.gitconfig` includeIf folder so the clone commits as the right git user, but that resolution
 * happens entirely outside the engine. Here it is just a path segment.
 *
 * ⚠ `path` AND `repos-path` ARE TEMPLATES, rendered here. They were joined onto the workspace root
 * as literal text, so the one thing an attached repo most often IS — a checkout somewhere else on
 * this machine, named by an `.env` key because the place differs per machine — was inexpressible.
 * `--path '${env:REPOS_FOLDER}/acme'` did not fail; `ensure` cloned into a directory whose name was
 * the eleven characters `${env:REPOS_FOLDER}`, inside the workspace. The record still carries the
 * template verbatim, as every record does; this is the read side rendering it at the point of need,
 * against the same context `dt resolve` builds. `path.resolve`, not `join`, because an absolute
 * rendering has to escape the workspace while a plain relative override still anchors to it.
 *
 * It THROWS on an undeclared or valueless var, which is `renderTemplate`'s contract and the right
 * one here: a repo path this machine cannot state is not a repo path to guess at. `listRepos`
 * catches per record so one such repo cannot take a whole listing down with it.
 */
/** A `repos` record's fields: where it clones from, and where it goes (`path`, else `<repos_path>/[<identity>/]<name>`). */
export type RepoFields = { url?: string; ref?: string; path?: string; name?: string; identity?: string }

/** A package spec read to its manifest: a local folder (linked), a tarball, or a registry version. */
export type SpecEntry = { kind: "folder" | "tarball" | "registry"; spec: string; manifest: PackageJson }

export type FolderIndex = Map<string, { version: string; file: string; manifest: PackageJson }[]>

/** `hooks.afterNpm` is a test seam the CLI never sets: an interruption between npm and compile */
export type InstallHooks = { afterNpm?: () => void | Promise<void> }

/** A source file compile read: workspace-relative path and content hash (what staleness compares). */
export type SourceRef = { path: string; hash: string }

/** One collection source as compile grouped it: the file, its parsed doc, and the module that ships it. */
export type DescriptorSource = { src: SourceRef; doc: AuthoredDescriptor; moduleName: string }

/** A discovered module, as `discoverModules` reports it. */
export type ModuleSource = { name: string; root: string; channel: string; layer?: string }

/** A record layer as compile reads it: the clone, its data folder, and the collections it narrows to (null: all). */
export type CompileLayer = {
  name: string
  root: string
  dataPath: string
  records: string[] | null
  /** set by compile: some collection here skips one of the layer's, so it is never read completely */
  skipsSome?: boolean
}

/** One collection compile resolved: the doc it writes, its resolved fields, its sources and storage facts. */
export type CompiledCollection = {
  doc: AuthoredDescriptor & { compiled?: Descriptor["compiled"] }
  resolved: Record<string, Field>
  sources: SourceRef[]
  compiled: Descriptor["compiled"]
  storage: {
    path: string
    format: string
    shape: string
    entry?: string
    under?: NonNullable<AuthoredDescriptor["storage"]>["under"]
    repo: string
    runtime: boolean
  }
}

/** What an extension's harness renderer returns: managed blocks by file (null removes one), and its summary. */
export type HarnessOut = { blocks?: Record<string, string | null>; summary?: string }

export type CollectionRow = HarnessContext["collections"][number] & { useWhen: string; write: string }

export type ModuleRow = HarnessContext["modules"][number] & {
  namespaces: string[]
  bin: string[]
  skills: string[]
  commands: string[]
}

export type Contributions = { rendered: [id: string, out: HarnessOut][]; paragraphs: string[] }

/** A compiled entry's YAML — a module record, a mixin, a command-binding, a skill's frontmatter — as far as
 *  the harness surface reads it. Sources were validated by compile; this only names the keys used here. */
export type EntryDoc = {
  name?: string
  title?: string
  description?: string
  path?: string
  namespaces?: string[]
  bin?: string[]
  skills?: string[]
  collection?: string
  command?: string
  available_when?: unknown
  done_when?: unknown
  [k: string]: unknown
}

/** What a ui-view or command-binding check finds: `v1` when it is the old spelling (compile's own refusal). */
export type ViewCheck = { v1?: true; errors: string[]; warnings: string[] }

/** A unit as the driver runs it: the validated unit, its package's folder and the env keys the package declares. */
export type DrivenUnit = SetupUnit & { dir?: string; declared: Set<string> }

/** One `--input` flag: `unit` is null for the unscoped `id=value` form. */
export type InputFlag = { unit: string | null; id: string; value: string }

/** An input whose value the engine refused (a bad secret-path, two values for one key). */
export type InputProblem = { unit: string; id: string; reason: string; required: boolean; env: string | null }

/** One unit's line, folded from its checks. */
export type Folded = { state: string; detail: string; verified: string | null }

/** An action left for later, and why; an env action's values are replaced by its key names. */
export type PendingAction = Omit<SetupAction, "env"> & { why: string; env?: SetupAction["env"] | string[] }

export type UnitRun = {
  checks: SetupCheck[]
  applied: { id: string; changed: string[]; message?: string }[]
  pending: PendingAction[]
  failed: { id: string; message: string }[]
  needs: string[]
}

/** One unit's report from `dt setup` / `dt install`: its folded line, what ran, what is left, what it needs. */
export type UnitResult = Folded &
  Omit<UnitRun, "checks"> & { id: string; module: string; checks?: SetupCheck[]; problems?: InputProblem[] }

/** The terminal's prompt and y/n — or a caller's stand-in for them. */
export type SetupIO = {
  prompt: (input: SetupInput, def: unknown) => Promise<unknown>
  ask: (action: SetupAction | PendingAction, kinds: string[]) => Promise<boolean>
}

/** One line of `dt status`'s setup section. */
export type StatusLine = Folded & {
  package: string | null
  unit: string | null
  grouped?: boolean
  checks: SetupCheck[]
  next: string
}

/** What `renderTemplate` renders AGAINST, for one workspace: the names `dreamteamer.vars` declares,
 *  the values this machine's `.env` carries, and the root. One builder rather than three lines at
 *  each call site — `dt resolve` and `repos ensure` disagreeing about which vars are declared would
 *  be a path that renders in one verb and refuses in the other. */
export type EnvContext = { env: Map<string, string>; workspaceFolder: string; declared: string[] }
