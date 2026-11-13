// The PUBLIC CONTRACT's shapes — every type `dreamteamer` and `dreamteamer/records` publish. The
// declarations consumers compile against (dist/*.d.ts) are GENERATED from the source, so these are the
// types the exported functions are annotated with, and the code has to satisfy them: a declaration can
// no longer say one thing while the runtime does another (KNOWN_OPERATORS was declared an array and was
// a Set — review F8). Shapes the engine does not constrain (a record's fields, a descriptor's schema)
// are typed loosely on purpose: they are the workspace's.
//
// Types only — every import here is `import type`, erased by construction, so this file is no runtime
// edge of any layer (scripts/layers.ts skips type-only edges).
import type { Store } from "./store.ts"

export type Fields = Record<string, unknown>
/** One resolved field, in the descriptor's own vocabulary (see src/fields.js). */
export type Field = {
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
  display?: Record<string, unknown>
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
export type AuthoredDescriptor = {
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
export type DisplayBlock = {
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
export type Descriptor = AuthoredDescriptor & {
  compiled: {
    /** the authored keys compile supplied where the author was silent — read through the accessors */
    defaults: Partial<AuthoredDescriptor>
    module: string
    repo: string
    runtime: boolean
    under_collection?: string
    /** the record layers this collection is read from, and an env-pointed root's facts (see Storage) */
    layers?: { name: string; path: string; repo: string }[]
    external?: boolean
    unavailable?: string | null
    mirrors: string[]
    overlaid_by: string[]
    unresolved_peers: string[]
    layerable?: boolean
    fields: Record<string, Field>
    json_schema: Record<string, unknown>
  }
}
export type Storage = {
  path: string
  format: "md" | "yaml" | "json" | "binary"
  shape: "file" | "folder"
  suffix: string
  repo: string
  runtime: boolean
  /** the root is outside the workspace (an env-pointed path) · why it could not render, else null */
  external: boolean
  unavailable: string | null
  /** the record layers read beside the write root, and every root in read order (write root first) */
  layers: { name: string; path: string; repo: string }[]
  roots: { path: string; repo: string; layer?: string }[]
  entry?: string
  max_bytes?: number
  accept?: string[]
  under?: { parent: string; subfolder: string; collection: string; id: "independent" | "nested" }
}
export type Descriptors = Map<string, Descriptor>
export type Manifest = {
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
  /** the workspace's package name, its data folder, and the record layers it reads — what `exportsFacts` answers from */
  package?: string | null
  data_path?: string
  layers?: { name: string; root: string; data: string; package: string | null; reads: string[]; narrowed: boolean }[]
  /** sources compiled to nothing (and why a module was refused), so staleness still sees them change */
  inert?: { path: string; hash: string }[]
  refused?: { name: string; engine: string }[]
  [k: string]: unknown
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
export type CommandRow = {
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

// ---- the workspace half ----
/** Parsed command-line flags (`parseArgs`): `--x v` a string, a bare `--x` true, a repeated flag a list */
export type Flags = Record<string, string | boolean | string[]>
/** One `dreamteamer.git_modules` entry: a clone the workspace declares (`records` makes it a record layer) */
export type GitModuleEntry = {
  url?: string
  ref?: string
  records?: string[] | null
  module?: boolean
  [k: string]: unknown
}
/** The `dreamteamer` block of a workspace's or a module's package.json — the keys the engine reads (MANIFEST_KEYS) */
export type DreamteamerBlock = {
  title?: string
  description?: string
  workspace_module?: string
  data_path?: string
  namespaces?: string[]
  vars?: string[]
  env?: string[]
  auto_commit?: boolean
  harnesses?: string[]
  git_modules?: Record<string, GitModuleEntry>
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
  [k: string]: unknown
}
export type PackageJson = {
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
  /** setup units (`references/extensions.md`): `[{ id, version: 1, inputs, inspect, plan, apply }]` —
   *  untrusted until `validateSetup` checks every unit at load, so typed as what it is */
  setup?: unknown[]
  /** a line about a record's state that `dt next` prints under the bound commands — synchronous */
  next?(ctx: { root: string; ws: Workspace; collection: string; ids: string[] }): { id: string; text: string }[] | void
}
/** `warning: true` — printed by `dt check`, never counted (an engine that has it sets CHECK_WARNINGS) */
export type CheckItem = { file?: string; message: string; warning?: true }
export interface DoctorRow {
  label: string
  state: "ok" | "warn" | "bad"
  detail?: string
  fix?: string
}
export interface ExtensionContext {
  root: string
  ws: Workspace
  dt: typeof import("./api.ts")
}
export type Activate = (dt: typeof import("./api.ts")) => Contribution | Promise<Contribution>
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
  setup: {
    id: string
    version: number
    module: string
    inputs: unknown[]
    inspect?: unknown
    plan?: unknown
    apply?: unknown
  }[]
}
export type Entry = { sources: { path: string; hash: string }[]; bytes: Buffer }
export interface CompileDraft {
  /** runtime-relative path → staged entry; read-only */
  readonly entries: Map<string, Entry>
  /** the FINAL merged descriptors */
  readonly descriptors: Descriptors
  readonly modules: { id: string; name: string; root: string; channel: "inline" | "git" | "npm" }[]
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
