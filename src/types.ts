import type { Store } from "./store/Store.ts"

export type Fields = Record<string, unknown>

/** A field's `display` block — the closed key list compile enforces (`DISPLAY_KEYS` in src/fields.ts). */
interface FieldDisplay {
  editable?: boolean | "create"
  hidden?: Array<"list" | "form" | "record">
  form_section?: string
  placeholder?: string
  unit?: string
  unit_field?: string
  direction?: "ltr" | "rtl"
  width?: number
  viewer?: string
  editor?: string
  options?: Record<string, unknown>
}

/** One resolved field, in the descriptor's own vocabulary (see src/fields.js). */
export interface Field {
  type: string | string[]
  title?: string
  description?: string
  required?: boolean
  many?: boolean
  default?: unknown
  enum?:
    | unknown[]
    | Record<string, { label?: string; description?: string; icon?: string; color?: string; background?: string }>
  unique?: boolean
  mirror_of?: string
  on_delete?: "restrict" | "set-null"
  soft?: boolean
  sensitive?: boolean
  body?: boolean
  derived?: boolean
  virtual?: boolean
  deprecated?: boolean
  fields?: Record<string, Field>
  values?: string | Field
  item_title?: string
  display?: FieldDisplay
  /** the JSON-schema constraints a field may carry through */
  pattern?: string
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
  examples?: unknown[]
  const?: unknown
  passthrough?: boolean
  [k: string]: unknown
}

/** The descriptor keys an author writes (descriptor format v2). */
export interface AuthoredDescriptor {
  name: string
  title?: string
  singular?: string
  record_title?: string
  description?: string
  use_when?: string
  internal?: boolean
  sensitive?: boolean
  storage?: {
    path?: string
    format?: "md" | "yaml" | "json" | "binary"
    shape?: "file" | "folder"
    entry?: string
    suffix?: string
    under?: { parent: string; subfolder: string; id?: "independent" | "nested" }
    max_bytes?: number
    accept?: string[]
    /** who keeps the records of a module-shipped collection: the module (its own `data/`) or the workspace */
    owner?: "module" | "workspace"
  }
  ids?: { from?: string | string[]; pattern?: string }
  constraints?: unknown[]
  /** the fields as authored; `mixins` names the mixins merged in; `overlay: true` extends another module's collection */
  fields?: Record<string, Field>
  mixins?: string[]
  overlay?: boolean
  display?: DisplayBlock
  [k: string]: unknown
}

/** A descriptor's `display`: how every surface draws the collection (see PresentationCollection). */
export interface DisplayBlock {
  nav?: { icon?: string; order?: number; section?: string; label?: string; [k: string]: unknown }
  list?: { layout?: string; columns?: string[]; sort?: string; options?: Record<string, unknown>; [k: string]: unknown }
  record?: {
    layout?: string
    subtitle?: string
    badge?: string
    color_by?: string
    options?: Record<string, unknown>
    [k: string]: unknown
  }
  form?: { sections?: { title: string; fields: string[]; collapsed?: boolean }[]; [k: string]: unknown }
  [k: string]: Record<string, unknown> | undefined
}

/** A compiled descriptor: the authored v2 keys plus what compile decided. Read it through the accessors. */
export interface Descriptor extends AuthoredDescriptor {
  compiled: {
    /** the authored keys compile supplied where the author was silent — read through the accessors; per field, only the keys it supplied */
    defaults: { [K in keyof AuthoredDescriptor as K extends "fields" ? never : K]?: AuthoredDescriptor[K] } & {
      fields?: Record<string, Partial<Field>>
    }
    module: string
    repo: string
    runtime: boolean
    under_collection?: string
    /** an env-pointed root's facts (see Storage) */
    external?: boolean
    unavailable?: string | null
    mirrors: string[]
    overlaid_by: string[]
    unresolved_peers: string[]
    fields: Record<string, Field>
    json_schema: Record<string, unknown>
  }
}

export interface Storage {
  path: string
  format: "md" | "yaml" | "json" | "binary"
  shape: "file" | "folder"
  suffix: string
  repo: string
  runtime: boolean
  /** the root is outside the workspace (an env-pointed path) · why it could not render, else null */
  external: boolean
  unavailable: string | null
  entry?: string
  max_bytes?: number
  accept?: string[]
  under?: { parent: string; subfolder: string; collection: string; id: "independent" | "nested" }
}

export type Descriptors = Map<string, Descriptor>

export interface Manifest {
  compiled: string
  host: string
  engine: string
  namespaces: string[]
  modules: { name: string; location: string; channel: string; root: string }[]
  ui: string[]
  "adapter-outputs": string[]
  "adapter-blocks": string[]
  extensions?: { name: string; version: string }[]
  "source-kinds"?: { kind: string; exclude: string[]; extension: string }[]
  entries: Record<string, { sources: { path: string; hash: string }[]; hash: string }>
  /** the workspace's package name and its data folder — what `exportsFacts` answers from */
  package?: string | null
  data_path?: string
  /** sources compiled to nothing (and why a module was refused), so staleness still sees them change */
  inert?: { path: string; hash: string }[]
  refused?: { name: string; engine: string }[]
  [k: string]: unknown
}

/** A `modules` record's fields (collections/modules.collection.yaml) — projected by compile from package.json. */
export interface ModuleFields {
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

/** One `modules` record as `moduleRows` returns it — the compiled projection of one module. */
export interface ModuleRecordRow {
  id: string
  fields: ModuleFields
}

/** One package `updateCheck` looked at: the engine or an npm module, what is installed and the newest release. */
export interface UpdateCheckRow {
  name: string
  kind: "engine" | "module"
  installed: string | null
  /** The version `dt update` would move to; null for a development link, or when the registry did not answer. */
  latest: string | null
  /** A development link (`npm link`, a folder spec): never pinned, so never offered. */
  linked: boolean
  /** `latest` is newer than `installed`. */
  outdated: boolean
  /** Why `latest` is unknown — the registry's refusal, in one line. */
  error?: string
}

/** A declared package whose installed version is not the one the checkout pins — what `dt install` makes match. */
export interface InstallDriftRow {
  name: string
  /** What package-lock.json names (else an exact package.json pin). */
  pinned: string
  /** What node_modules holds. */
  installed: string
}

/** The display contract (descriptor v2, design §4.3): what every surface draws from. */
export interface PresentationChoice {
  label: string
  value: string
  description?: string
  icon?: string
  color?: string
  background?: string
}

export interface PresentationComponentOptions {
  choices?: PresentationChoice[]
  fields?: PresentationField[]
  item_title?: string
  [option: string]: unknown
}

export interface PresentationField {
  collection?: string
  field: string
  type:
    | "string"
    | "markdown"
    | "html"
    | "integer"
    | "number"
    | "boolean"
    | "date"
    | "datetime"
    | "url"
    | "email"
    | "object"
    | "map"
    | "position"
  many?: true
  title: string
  description?: string
  required: boolean
  kind?: "derived" | "virtual" | "mirror"
  editable: boolean | "create"
  hidden?: Array<"list" | "form" | "record">
  role?: "body" | "reference" | "reference_many" | "mirror"
  editor?: string
  editor_options?: PresentationComponentOptions
  viewer?: string
  viewer_options?: PresentationComponentOptions
  mirror_of?: string
  on_delete?: string
  unique?: true
  nullable: boolean
  default?: unknown
  unit?: string
  unit_field?: string
  direction?: "ltr" | "rtl"
  width?: number
  placeholder?: string
  form_section?: string
  deprecated?: true
  sensitive?: true
}

export interface PresentationCollection {
  collection: string
  title: string
  nav: { icon?: string; order?: number; section?: string }
  list: { layout: string; columns?: string[]; sort?: string; options?: Record<string, unknown> }
  record: { layout: string; subtitle?: string; badge?: string; color_by?: string; options?: Record<string, unknown> }
  /** `collapsed`: the section is drawn shut, after every other field, until a person opens it */
  form: { sections: Array<{ title: string; fields: string[]; collapsed?: true }> }
  position_field?: string
  record_title?: string
  record_type: string
  runtime: boolean
  internal: boolean
}

export interface PresentationRelation {
  collection: string
  field: string
  related_collection: string
  list: boolean
  kind?: "m2o" | "o2o" | "m2m"
  mirror?: true
}

/** One command bound to a collection, and where it applies — `commandsFor`'s rows. */
export interface CommandRow {
  binding: string
  command: string
  name: string
  description: string
  "argument-hint": string | null
  scope: string
  /** per requested id: available · done · not-applicable (record scope only) */
  states?: Record<string, "available" | "done" | "not-applicable">
  eligible?: string[]
  done?: string[]
  /** what to type — the eligible ids only; null when none is */
  invocation: string | null
}

export interface Presentation {
  collections: PresentationCollection[]
  fields: Record<string, PresentationField[]>
  relations: PresentationRelation[]
}

/** Parsed command-line flags (`parseArgs`): `--x v` a string, a bare `--x` true, a repeated flag a list */
export type Flags = Record<string, string | boolean | string[]>

/**
 * The values actually present in one field of a collection (`distinctValues`, `dt values`). `count` is
 * null for an enum's declared values; `skipped` names a field kind that has no value set.
 */
export interface DistinctValues {
  collection: string
  field: string
  values: { value: string | number | boolean; count: number | null }[]
  total: number
  truncated: boolean
  source?: "enum" | "data"
  skipped?: "body" | "object"
}

/** The `dreamteamer` block of a workspace's or a module's package.json — the keys the engine reads (MANIFEST_KEYS) */
export interface DreamteamerBlock {
  title?: string
  description?: string
  workspace_module?: string
  data_path?: string
  namespaces?: string[]
  vars?: string[]
  env?: string[]
  auto_commit?: boolean
  harnesses?: string[]
  disable?: string[]
  local_assets?: string[]
  postinstall?: string | null
  gitignore_runtime_folder?: boolean
  repos_path?: string
  dependencies?: string[]
  peer_collections?: string[]
  owns_data?: boolean
  engine?: string
  extension?: string
  ignore?: string[]
  provides?: string[]
  setup?: { skipped?: string[]; [k: string]: unknown }
  /** A module PRESET: the modules it installs, package name → exact version. */
  preset?: Record<string, string>
  /** The package-relative path of the module's nav fragment (a nav.yaml). */
  nav?: string
  /** The package-relative folder a module's skills are STAGED from — its build output, e.g. `dist/skills`. */
  skills?: string
  /** A module's runnable scripts, name → package-relative file: what `dt run <module> <name>` runs. */
  scripts?: Record<string, string>
  [k: string]: unknown
}

export interface PackageJson {
  name?: string
  version?: string
  description?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  dreamteamer?: DreamteamerBlock
  [k: string]: unknown
}

export interface Workspace {
  /** absolute path of the workspace root */
  root: string
  /** the workspace package.json */
  pkg: PackageJson
  /** the ACTIVATED extensions, present on a handle from `openWorkspace` */
  extensions?: LoadedExtension[]
}

/** What an extension's `activate(dt)` returns. Every key is optional. */
export interface Contribution {
  commands?: Record<
    string,
    { usage?: string; run(ws: Workspace, argv: string[]): number | void | Promise<number | void> }
  >
  sourceKinds?: (string | { kind: string; exclude?: string[] })[]
  analyze?(draft: CompileDraft): { errors?: string[]; warnings?: string[]; notes?: string[] } | void
  harnesses?: Record<
    string,
    (ctx: HarnessContext) => { blocks?: Record<string, string | null>; summary?: string } | void
  >
  orientation?: string | ((ctx: { entries: Map<string, Entry> }) => string)
  hooks?: Record<string, string>
  /** cross-record rules: `dt check` reports what it returns after the schema's violations */
  check?(ctx: ExtensionContext): CheckItem[] | void | Promise<CheckItem[] | void>
  /** machine checks: `dt doctor` renders the rows as one capability named after the extension */
  doctor?(ctx: ExtensionContext): DoctorRow[] | void | Promise<DoctorRow[] | void>
  /**
   * setup units (`references/extensions.md`): `[{ id, version: 1, inputs, inspect, plan, apply }]` —
   * untrusted until `validateSetup` checks every unit at load, so typed as what it is
   */
  setup?: unknown[]
  /** a line about a record's state that `dt next` prints under the bound commands — synchronous */
  next?(ctx: { root: string; ws: Workspace; collection: string; ids: string[] }): { id: string; text: string }[] | void
}

/** `warning: true` — printed by `dt check`, never counted (an engine that has it sets CHECK_WARNINGS) */
export interface CheckItem {
  file?: string
  message: string
  warning?: true
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
  dt: Api
}

/** The engine's public API — what `dreamteamer` exports, and what an extension's `activate` is handed. */
export type Api = typeof import("./api.ts")

export type Activate = (dt: Api) => Contribution | Promise<Contribution>

export interface LoadedExtension {
  name: string
  version: string
  commands: NonNullable<Contribution["commands"]>
  sourceKinds: { kind: string; exclude: string[]; extension: string }[]
  analyze: Contribution["analyze"] | null
  harnesses: NonNullable<Contribution["harnesses"]>
  orientation: Contribution["orientation"] | null
  hooks: Record<string, string>
  check: Contribution["check"] | null
  doctor: Contribution["doctor"] | null
  next: Contribution["next"] | null
  /** the package's folder, and the env keys and vars it declares */
  dir: string
  env: string[]
  vars: string[]
  /** its setup units, validated */
  setup: SetupUnit[]
}

export type SetupInputKind = "string" | "path" | "rows" | "secret-path"

/** One input a unit needs from the person, as `validateSetup` normalized it. */
export interface SetupInput {
  id: string
  kind: SetupInputKind
  env?: string
  required: boolean
  title: string
  default?: unknown
  prompt?: string
  rows?: { columns: string[]; [k: string]: unknown }
}

type SetupCheckStatus = "ready" | "configured" | "unverified" | "missing" | "blocked"

/** One row of what a unit's `inspect` (or `plan`) found. `status` is untrusted until `fold` reads it. */
export interface SetupCheck {
  id: string
  status: SetupCheckStatus | string
  title?: string
  detail?: string
  fix?: string
  /** a verify action's receipt: when it was last proved */
  evidence?: { at?: string; [k: string]: unknown }
}

interface SetupEffect {
  kind: string
  detail?: string
}

/** One step a unit's `plan` names. `env` makes it the engine's own `.env` write; `state` is the driver's verdict on it. */
export interface SetupAction {
  id: string
  title?: string
  kind?: string
  effects?: SetupEffect[]
  preview?: string
  expect?: string
  runBy?: string
  state?: string
  reason?: string
  env?: Record<string, unknown>
}

export interface SetupPlan {
  checks?: SetupCheck[]
  actions?: SetupAction[]
  needs?: string[]
}

/** What a unit's functions are handed. `dt` is null under the read-only verbs (`dt status`, `dt doctor`). */
export interface SetupContext {
  root: string
  ws: Workspace
  dt: Api | null
  env: Record<string, string>
  tty: boolean
  receiptDir: string
}

export type SetupInputs = Record<string, unknown>

/** A setup unit, validated: `inspect` is synchronous and side-effect-free; `apply` performs a previewed action. */
export interface SetupUnit {
  id: string
  version: number
  module: string
  inputs: SetupInput[]
  inspect: (ctx: SetupContext) => { checks?: SetupCheck[] } | null | undefined
  plan: (ctx: SetupContext, inputs: SetupInputs) => SetupPlan | Promise<SetupPlan>
  apply?: (
    ctx: SetupContext,
    action: SetupAction,
    inputs: SetupInputs
  ) =>
    | { ok: boolean; changed?: string[]; message?: string }
    | null
    | undefined
    | Promise<{ ok: boolean; changed?: string[]; message?: string } | null | undefined>
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
  readonly modules: { id: string; name: string; root: string; channel: "inline" | "npm" }[]
  /** names only — never values */
  readonly declaredVars: string[]
  readonly declaredEnv: string[]
  readonly previousManifest: Manifest | null
  /** parse one staged YAML entry, with its source path in any error */
  parse<T = Record<string, unknown>>(runtimePath: string): T
}

export interface HarnessContext {
  entries: Map<string, Entry>
  version: string
  collections: {
    name: string
    generated: boolean
    systemGroup: boolean
    description: string
    module: string
    sensitive: boolean
    sensitiveFields: string[]
  }[]
  modules: { id: string; title: string; description: string; path: string }[]
}

/** One part of a parsed template: literal text, or a token naming a field and its filters. */
export type TemplatePart = { text: string } | { field: string; filters: { name: string; arg?: string }[] }

export type SchemaOp = (ws: Workspace, store: Store, ...args: never[]) => unknown

/** One engine run: its exit status (null when it was ended on `timeoutMs`), stdout and stderr. */
export interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

export interface RunOptions {
  /** Laid over the process environment (and the synthetic git identity) for this run. */
  env?: Record<string, string>
  /** Ends the run by SIGKILL after this many milliseconds; `status` is then null. Default 60 000. */
  timeoutMs?: number
  /** Text handed to the run's stdin (a hook payload, a prompt's answer). */
  input?: string
}

/** A workspace `createWorkspace` made: its root, the engine it runs on, and `run` bound to it. */
export interface TestWorkspace {
  root: string
  engine: string
  dt(args: string[], opts?: RunOptions): RunResult
}

/** One entry of nav.yaml's tree: a collection by name, its long form, a folder, or a namespace folder. */
export type NavEntry =
  | string
  | { collection: string; icon?: string }
  | { folder: string; icon?: string; hidden?: boolean; items: NavEntry[] }
  | { namespace: string; icon?: string; hidden?: boolean; items?: NavEntry[] }

/** The whole nav.yaml: the drawn tree, and the rows not drawn at all. */
export interface NavDoc {
  tree: NavEntry[]
  hidden: string[]
}

/** One thing `validateNavDoc` reports — never a violation. */
export interface NavWarning {
  warning: string
}
