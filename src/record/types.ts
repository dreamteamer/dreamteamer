import type { Storage, TemplatePart } from "../types.ts"

/** One pending record file `git status` reported, mapped back to its record. */
export type Row = { verb: string; collection: string; id: string; repoRel: string; fromRel: string | null }

/** What `renderTemplate` renders AGAINST, for one workspace: the names `dreamteamer.vars` declares,
 *  the values this machine's `.env` carries, and the root. One builder rather than three lines at
 *  each call site — `dt resolve` and `repos ensure` disagreeing about which vars are declared would
 *  be a path that renders in one verb and refuses in the other. */
export type EnvContext = { env: Map<string, string>; workspaceFolder: string; declared: string[] }

export type ChangeKind = "created" | "updated" | "deleted"

/** One record's change, keyed by `ref` per `repo` — the shape `foldChanges` folds and `groupChanges` groups. */
export type RecordChange = {
  collection: string
  id: string
  ref: string
  repo: string
  change: ChangeKind
  layer?: string | null
  path?: string
}

export type ChangeGroup<T extends RecordChange = RecordChange> = {
  collection: string
  layer: string | null
  created: number
  updated: number
  deleted: number
  records: T[]
}

export type ExportEntry = { label: string; from?: string }

/** A collection root as one context sees it: its layer (null: the write root), its package, whether it is on disk. */
export type ContextRoot = { layer: string | null; package: string | null; present: boolean }

export type ExportsContext = {
  own: string | null
  rootsOf: (coll: string) => ContextRoot[]
  complete: (layer: string | null) => boolean
  packageOf: (layer: string | null) => string | null
  rootOf: (layer: string | null) => string
}

export type OutsideRef = { collection: string; id: string; resolved: ExportEntry | null; referrers: string[] }

export type ExportChange = { ref: string; kind: "drop" | "fill" | "refresh" | "add"; why: string }

/** The manifest of the repo rooted at `dir` — `{ <collection>: { <id>: { label, from? } } }` — or null
 *  when it has none. An unparseable file throws, naming its path: it is never read as empty. */
/** A repo's exports manifest: per collection, per id, its display label and the package that held it. */
export type ExportRefs = Record<string, Record<string, { label: string; from?: string }>>

/** A collection's `storage.under`: the reference field naming its parent, and where inside the parent it lives. */
export type Under = NonNullable<Storage["under"]>

/** One record found under a root: its id, its file, the root it was read from, and the parent record it sits in. */
export type PlacedRecord = { id: string; file: string; root: string; parentId: string | null }

export type OnLink = ((link: string) => void) | null

/** One relation, keyed by its owner: `owner.field` references `target`, whose `mirror` field is the generated far side. */
export type Relation = {
  owner: string
  field: string
  target: string
  mirror: string
  list: boolean
  unique: boolean
  onDelete: "restrict" | "set-null"
  kind: "m2o" | "o2o" | "m2m"
}

/** Render ONE template, or throw if a field it names is missing. The list form loops over this. */
export type OnFallback = (e: { field: string; value: string; id: string }) => void

/** The fields a template names, in order, built-ins included. */
export type FieldPart = Extract<TemplatePart, { field: string }>

/**
 * Normalize every temporal in a record IN PLACE, walking the schema (not the data) so only
 * declared date/date-time fields are touched — a plain string that happens to look like a date
 * stays exactly as the author typed it. Recurses through object properties and array items.
 */
/** The slice of a JSON schema the temporal readers walk. */
export type SchemaProp = {
  type?: string | string[]
  format?: string
  properties?: Record<string, SchemaProp>
  items?: SchemaProp
  enum?: unknown[]
}
