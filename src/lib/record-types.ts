// The record half's shapes, for the modules that implement it. Type-only: erased at build, so it emits
// an empty module and adds no edge a runtime walks.
//
// ⚠ src/records-api.d.ts is the PUBLISHED contract and keeps its own copy of these. The two must agree;
// a change here that a consumer can see is a change there too. Shapes the engine does not constrain
// (a record's fields, a descriptor's schema) are typed loosely on purpose: they are the workspace's.

export type Fields = Record<string, unknown>

export interface EnumChoice {
  label?: string
  description?: string
  icon?: string
  color?: string
  background?: string
}

/** One resolved field, in the descriptor's own vocabulary (see src/fields.ts). */
export interface Field {
  type: string | string[]
  title?: string
  description?: string
  required?: boolean
  many?: boolean
  minItems?: number
  maxItems?: number
  default?: unknown
  enum?: unknown[] | Record<string, EnumChoice>
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
  [k: string]: unknown
}

/** How surfaces draw a field — the authored `display` block of one field. */
export interface FieldDisplay {
  /** the form section the field sits in */
  form_section?: string
  editor?: string
  viewer?: string
  editable?: boolean | "create"
  hidden?: Array<"list" | "form" | "record">
  /** handed to the editor and viewer components verbatim */
  options?: Record<string, unknown>
  unit?: string
  unit_field?: string
  direction?: "ltr" | "rtl"
  width?: number
  placeholder?: string
  [k: string]: unknown
}

export type StorageFormat = "md" | "yaml" | "json" | "binary"
export type StorageShape = "file" | "folder"
export type UnderId = "independent" | "nested"

export interface Ids {
  from?: string | string[]
  pattern?: string
}

/** `display:` — how surfaces draw a collection. Each sub-block is the author's keys over compile's defaults. */
export interface Display {
  nav?: DisplayNav
  list?: DisplayList
  record?: DisplayRecord
  form?: DisplayForm
}
export interface DisplayNav {
  icon?: string
  order?: number
  section?: string
  [k: string]: unknown
}
export interface DisplayList {
  layout?: string
  columns?: string[]
  sort?: string
  options?: Record<string, unknown>
  [k: string]: unknown
}
export interface DisplayRecord {
  layout?: string
  subtitle?: string
  badge?: string
  color_by?: string
  options?: Record<string, unknown>
  [k: string]: unknown
}
export interface DisplayForm {
  sections?: { title: string; fields: string[]; collapsed?: boolean }[]
  [k: string]: unknown
}

/** What compile supplied because the author did not — the same keys, read under the authored ones. */
export interface DescriptorDefaults {
  title?: string
  singular?: string
  record_title?: string
  ids?: Ids
  storage?: AuthoredStorage
  display?: Display
  [k: string]: unknown
}

/** A record layer: a clone whose listed collections are read here (`storageOf(d).layers`). */
export interface StorageLayer {
  name: string
  path: string
  repo: string
}

/** One folder a collection's records are read from — the write root first, then each layer's. */
export interface StorageRoot {
  path: string
  repo: string
  layer?: string
}

/** What compile decided about a descriptor — read it through the accessors in src/descriptor.ts. */
export interface CompiledBlock {
  defaults: DescriptorDefaults
  module: string
  repo: string
  runtime: boolean
  under_collection?: string
  /** an env-pointed root rendered outside the workspace: no repo here publishes it */
  external?: boolean
  /** why an env-pointed root could not render on this machine */
  unavailable?: string | null
  layers?: StorageLayer[]
  /** a record layer can contribute this collection */
  layerable?: boolean
  mirrors: string[]
  overlaid_by: string[]
  unresolved_peers: string[]
  fields: Record<string, Field>
  json_schema: Record<string, unknown>
}

/** `storage:` as the author wrote it. */
export interface AuthoredStorage {
  /** who owns the data folder: the workspace (default) or the module that ships the collection */
  owner?: "module" | "workspace"
  path?: string
  format?: StorageFormat
  shape?: StorageShape
  entry?: string
  suffix?: string
  under?: { parent: string; subfolder: string; id?: UnderId }
  max_bytes?: number
  accept?: string[]
}

/** A compiled descriptor: the authored v2 keys plus what compile decided. Read it through the accessors. */
export interface Descriptor {
  name: string
  title?: string
  singular?: string
  record_title?: string
  description?: string
  use_when?: string
  internal?: boolean
  sensitive?: boolean
  storage?: AuthoredStorage
  ids?: Ids
  constraints?: unknown[]
  display?: Display
  compiled: CompiledBlock
  [k: string]: unknown
}

/** A descriptor's storage, every default applied (`storageOf`). */
export interface Storage {
  path: string
  format: StorageFormat
  shape: StorageShape
  suffix: string
  repo: string
  runtime: boolean
  entry?: string
  max_bytes?: number
  accept?: string[]
  under?: { parent: string; subfolder: string; collection: string; id: UnderId }
  /** the rendered folder is outside the workspace (an env-pointed root) */
  external: boolean
  /** why an env-pointed root could not render; `path` is then still the template */
  unavailable: string | null
  layers: StorageLayer[]
  /** the write root, then each layer's */
  roots: StorageRoot[]
}

export type Descriptors = Map<string, Descriptor>

export interface ManifestModule {
  name: string
  location: string
  channel: string
  root: string
}

export interface ManifestSource {
  path: string
  hash: string
}

/** What compile records per record layer, for judging an exports manifest without package.json. */
export interface ManifestLayer {
  name: string
  root: string
  /** the layer's data folder, workspace-relative */
  data: string
  package: string | null
  /** the collections read from it */
  reads: string[]
  /** `records:` narrows what is read */
  narrowed: boolean
}

export interface Manifest {
  compiled: string
  host: string
  engine: string
  namespaces: string[]
  /** this workspace's package name (absent on a runtime older than cr-dt-004) */
  package?: string | null
  data_path?: string
  layers?: ManifestLayer[]
  modules: ManifestModule[]
  ui: string[]
  "adapter-outputs": string[]
  "adapter-blocks": string[]
  extensions?: { name: string; version: string }[]
  "source-kinds"?: { kind: string; exclude: string[]; extension: string }[]
  /** sources compile read and staged nothing from — still hashed, so editing one is staleness */
  inert?: ManifestSource[]
  /** extensions refused for the engine range they need */
  refused?: { name: string; engine: string }[]
  entries: Record<string, { sources: ManifestSource[]; hash: string }>
  [k: string]: unknown
}

/** The workspace package.json, as far as the engine reads it. */
export interface WorkspacePkg {
  name?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  dreamteamer?: Record<string, any>
  [k: string]: unknown
}

/** What `renderTemplate` renders against (`envContext`): this machine's `.env`, the root, the declared var names. */
export interface EnvContext {
  env: Map<string, string>
  workspaceFolder: string
  declared: string[]
}

/** The handle the record half takes: a root and, when known, its package.json. The workspace half
 *  extends it with the activated extensions (src/workspace-types.ts). */
export interface WorkspaceRoot {
  root: string
  pkg?: WorkspacePkg
}

/** What `findWorkspace` returns. */
export interface FoundWorkspace extends WorkspaceRoot {
  pkg: WorkspacePkg
}

// ---- records and history -------------------------------------------------------------------------

export interface RecordRead {
  fields: Fields
  file: string
}

export interface RecordRow extends RecordRead {
  id: string
}

export interface ExternalRecord {
  label: string
  from?: string
  manifest: string
}

export interface RelocateMove {
  id: string
  from: string
  to: string
  why: "placement" | "shape" | "to-root"
}

export interface RelocatePlan {
  collection: string
  moves: RelocateMove[]
  problems: string[]
}

export interface CheckExtra {
  file: string
  msg: string
  /** printed, never counted as a violation */
  warning?: boolean
}

export interface CommitRow {
  verb: string
  collection: string
  id: string
}

export interface CommitResult {
  repo: string
  sha?: string
  subject: string
  rows: CommitRow[]
  blocked?: string
  failed?: string
  pending?: string
  warning?: string
  leftPending?: string[]
  /** an env-pointed collection outside the workspace: kept here, never committed */
  outside?: string
  /** its `storage.path` template */
  template?: string
}

export interface CommitOptions {
  only?: string[]
  message?: string
  dryRun?: boolean
}

export interface HistoryEntry {
  hash: string
  date: string
  author: string
  subject: string
}

export interface HistoryDiff {
  hash: string
  path: string
  diff: string
}

export interface RecordEvent {
  type: "item-added" | "item-updated" | "item-removed"
  collection: string
  id: string
  path: string
  repo: string
}

export interface Ref {
  collection: string
  id: string
}

/** Where `placementKey` puts a record: one of the four. */
export interface PlacementWhere {
  top?: boolean
  bottom?: boolean
  after?: string
  before?: string
}

/** `distinctValues`: a field's vocabulary — declared (an enum, counts null) or observed in the data. */
export interface DistinctValues {
  collection: string
  field: string
  values: { value: unknown; count: number | null }[]
  total: number
  truncated: boolean
  source?: "enum" | "data"
  /** a field with no sane dropdown: a markdown body, or an object */
  skipped?: "body" | "object"
}

// ---- templates -------------------------------------------------------------------------------------

/** One part of a parsed template: literal text, or a token naming a field and its filters. */
export type TemplatePart = TemplateText | TemplateToken
export interface TemplateFilter {
  name: string
  arg?: string
}
// The absent member is declared `?: undefined` on each side so `p.field` / `p.text` narrow by truthiness.
export interface TemplateText {
  text: string
  field?: undefined
  filters?: undefined
}
export interface TemplateToken {
  field: string
  filters: TemplateFilter[]
  text?: undefined
}

// ---- the nav document --------------------------------------------------------------------------------

/** One entry of nav.yaml's tree: a collection by name, its long form, a folder, or a namespace folder. */
export type NavEntry =
  | string
  | { collection: string; icon?: string }
  | { folder: string; icon?: string; hidden?: boolean; items: NavEntry[] }
  | { namespace: string; icon?: string; hidden?: boolean; items?: NavEntry[] }

export interface NavDoc {
  tree: NavEntry[]
  hidden: string[]
}

// ---- the display contract (descriptor v2, design §4.3) -------------------------------------------------

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
export interface Presentation {
  collections: PresentationCollection[]
  fields: Record<string, PresentationField[]>
  relations: PresentationRelation[]
}

/** A relation, decoded once from a mirror field (`relationsOf`), keyed by its owner. */
export interface Relation {
  /** the collection whose field holds the reference */
  owner: string
  field: string
  /** the collection the mirror sits on */
  target: string
  mirror: string
  list: boolean
  unique: boolean
  onDelete: "restrict" | "set-null"
  kind: "m2m" | "o2o" | "m2o"
}
