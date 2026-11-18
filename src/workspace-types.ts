// The workspace half's shapes — extensions, compile, harnesses — for the modules that implement it.
// Type-only: erased at build.
//
// ⚠ src/api.d.ts is the PUBLISHED contract and keeps its own copy of these; the two must agree.
import type { Descriptors, FoundWorkspace, Manifest } from "./record-types.ts"
import type { Store } from "./store.ts"

/** The engine's public API as an extension receives it. Typed loosely here: the precise type is the
 *  module namespace of src/api.ts, which this layer cannot name without importing the surface. */
export type EngineApi = { readonly [name: string]: any }

/** The workspace handle: root, package.json and — on one from `openWorkspace` — the activated extensions. */
export interface Workspace extends FoundWorkspace {
  extensions?: LoadedExtension[]
}

export interface Entry {
  sources: { path: string; hash: string }[]
  bytes: Buffer
}

export interface CompileDraft {
  /** runtime-relative path → staged entry; read-only */
  readonly entries: Map<string, Entry>
  /** the FINAL merged descriptors */
  readonly descriptors: Descriptors
  readonly modules: { id: string; name: string; root: string; channel: ModuleChannel }[]
  /** names only — never values */
  readonly declaredVars: string[]
  readonly declaredEnv: string[]
  readonly previousManifest: Manifest | null
  /** parse one staged YAML entry, with its source path in any error */
  parse(runtimePath: string): any
}

export interface HarnessCollection {
  name: string
  generated: boolean
  systemGroup: boolean
  description: string
  module: string
  sensitive: boolean
  sensitiveFields: string[]
}

export interface HarnessContext {
  entries: Map<string, Entry>
  version: string
  collections: HarnessCollection[]
  modules: { id: string; title: string; description: string; path: string }[]
}

export interface DoctorRow {
  label: string
  state: "ok" | "warn" | "bad"
  detail?: string
  fix?: string
}

export interface ExtensionContext {
  root: string
  ws: Workspace
  dt: EngineApi
}

export interface ExtensionIssue {
  file?: string
  message: string
  warning?: boolean
}

export interface ExtensionCommand {
  usage?: string
  run(ws: Workspace, argv: string[]): number | void | Promise<number | void>
}

export interface AnalyzeResult {
  errors?: string[]
  warnings?: string[]
  notes?: string[]
}

export type HarnessFn = (ctx: HarnessContext) => { blocks?: Record<string, string | null>; summary?: string } | void

/** What an extension's `activate(dt)` returns. Every key is optional. */
export interface Contribution {
  commands?: Record<string, ExtensionCommand>
  sourceKinds?: (string | { kind: string; exclude?: string[] })[]
  analyze?(draft: CompileDraft): AnalyzeResult | undefined
  harnesses?: Record<string, HarnessFn>
  orientation?: string | ((ctx: { entries: Map<string, Entry> }) => string)
  hooks?: Record<string, string>
  /** cross-record rules: `dt check` reports what it returns after the schema's violations */
  check?(ctx: ExtensionContext): ExtensionIssue[] | undefined | Promise<ExtensionIssue[] | undefined>
  /** machine checks: `dt doctor` renders the rows as one capability named after the extension */
  doctor?(ctx: ExtensionContext): DoctorRow[] | undefined | Promise<DoctorRow[] | undefined>
  /** a line about a record's state that `dt next` prints under the bound commands — synchronous */
  next?(ctx: {
    root: string
    ws: Workspace
    collection: string
    ids: string[]
  }): { id: string; text: string }[] | undefined
  /** setup units, as authored — `validateSetup` (src/setup-contract.ts) judges them at load */
  setup?: unknown
}

export type Activate = (dt: EngineApi) => Contribution | Promise<Contribution>

export interface SourceKind {
  kind: string
  exclude: string[]
  extension: string
}

export interface LoadedExtension {
  name: string
  version: string
  /** the package folder */
  dir: string
  /** the `.env` keys and `vars` names its package declares */
  env: string[]
  vars: string[]
  commands: Record<string, ExtensionCommand>
  sourceKinds: SourceKind[]
  analyze: Contribution["analyze"] | null
  harnesses: Record<string, HarnessFn>
  orientation: Contribution["orientation"] | null
  hooks: Record<string, string>
  check: Contribution["check"] | null
  doctor: Contribution["doctor"] | null
  next: Contribution["next"] | null
  /** its validated setup units (src/setup-contract.ts) */
  setup: SetupUnit[]
}

export interface DeclaredExtension {
  name: string
  version: string
  dir: string
  /** the absolute path of its `dreamteamer.extension` entry */
  entry: string
  env: string[]
  vars: string[]
}

export interface ContributedNote {
  id: string | null
  text: string
  by: string
  error?: true
}

/** A repo record made present (`ensureRepo`): where, whether this call cloned it, and the ref it is on. */
export interface EnsuredRepo {
  id: string
  path: string
  present: boolean
  cloned: boolean
  ref: string
}

/** A repo record as `listRepos` observes it; `unresolved` says why its path cannot render here. */
export interface ListedRepo {
  id: string
  path: string
  present: boolean
  unresolved?: string
}

/** What `describeCheckout` reports about a working tree. */
export interface Checkout {
  root: string
  kind: "primary" | "linked"
  gitDir: string
  commonDir: string
  primary: string
  insideRoot: boolean
}

/** A hook's stdin, read: the session's cwd, the hook event's name, and every key it carried. */
export interface HookInput {
  cwd: string | null
  name: string | null
  raw: Record<string, unknown>
}

/** One engine run: its exit status (null when it was ended on `timeoutMs`), stdout and stderr. */
export interface EngineRun {
  status: number | null
  stdout: string
  stderr: string
}

export interface EngineRunOptions {
  /** laid over the process environment (and the synthetic git identity) for this run */
  env?: Record<string, string>
  /** ends the run by SIGKILL after this many milliseconds; `status` is then null */
  timeoutMs?: number
  /** text handed to the run's stdin */
  input?: string
}

/** A schema or module operation: the workspace, its store, then the operation's own arguments. */
export type SchemaOp = (ws: Workspace, store: Store, ...args: any[]) => any

/** One input a setup unit asks for, as `validateSetup` normalises it. */
export interface SetupInput {
  id: string
  kind: string
  /** the `.env` key it is written to */
  env: string
  required: boolean
  title: string
  default?: unknown
  [k: string]: unknown
}

/** A setup unit an extension contributes, validated (src/setup-contract.ts). */
export interface SetupUnit {
  id: string
  version: number
  /** the package that contributes it */
  module: string
  inputs: SetupInput[]
  inspect: (...args: any[]) => unknown
  plan: (...args: any[]) => unknown
  apply: (...args: any[]) => unknown
}

/** How a module arrived: `modules/<id>` in the workspace, a clone under `git_modules/`, or an npm dependency. */
export type ModuleChannel = "inline" | "git" | "npm"

/** One module compile reads: its package name, folder and the channel it arrived through. */
export interface DiscoveredModule {
  name: string
  root: string
  channel: ModuleChannel
  /** set on a module a record layer's clone bundles */
  layer?: string
}

/** `discoverModules`: what compile reads, what lost to a same-named copy, and what was refused. */
export interface ModuleDiscovery {
  modules: DiscoveredModule[]
  /** a name found on two channels: the winner's channel, and the loser's */
  shadows: { name: string; winner: ModuleChannel; loser: ModuleChannel }[]
  disabledModules: string[]
  layerRefusals: string[]
}

/** `staleness`: whether a runtime exists, and the sources that changed since it was compiled. */
export interface Staleness {
  compiled: boolean
  stale: string[]
  manifest?: Manifest
  message?: string
}
