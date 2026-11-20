import type { Storage, TemplatePart } from "../types.ts"

export interface ExportEntry {
  label: string
  from?: string
}

export interface ExportsContext {
  /** this workspace's package name */
  own: string | null
  /** this workspace's root — where its exports manifest sits */
  root: string
  /** does this workspace have the collection */
  reads: (coll: string) => boolean
  /** is every record under the data folder read by some collection here */
  complete: () => boolean
}

export interface OutsideRef {
  collection: string
  id: string
  resolved: ExportEntry | null
  referrers: string[]
}

export interface ExportChange {
  ref: string
  kind: "drop" | "fill" | "refresh" | "add"
  why: string
}

/**
 * The manifest of the repo rooted at `dir` — `{ <collection>: { <id>: { label, from? } } }` — or null
 * when it has none. An unparseable file throws, naming its path: it is never read as empty.
 */
/** A repo's exports manifest: per collection, per id, its display label and the package that held it. */
export type ExportRefs = Record<string, Record<string, { label: string; from?: string }>>

/** A collection's `storage.under`: the reference field naming its parent, and where inside the parent it lives. */
export type Under = NonNullable<Storage["under"]>

/** One record found under a root: its id, its file, the root it was read from, and the parent record it sits in. */
export interface PlacedRecord {
  id: string
  file: string
  root: string
  parentId: string | null
}

export type OnLink = ((link: string) => void) | null

/** One relation, keyed by its owner: `owner.field` references `target`, whose `mirror` field is the generated far side. */
export interface Relation {
  owner: string
  field: string
  target: string
  mirror: string
  list: boolean
  unique: boolean
  onDelete: "restrict" | "set-null"
  kind: "m2o" | "o2o" | "m2m"
}

/** The fields a template names, in order, built-ins included. */
export type FieldPart = Extract<TemplatePart, { field: string }>

/**
 * Normalize every temporal in a record IN PLACE, walking the schema (not the data) so only
 * declared date/date-time fields are touched — a plain string that happens to look like a date
 * stays exactly as the author typed it. Recurses through object properties and array items.
 */
/** The slice of a JSON schema the temporal readers walk. */
export interface SchemaProp {
  type?: string | string[]
  format?: string
  properties?: Record<string, SchemaProp>
  items?: SchemaProp
  enum?: unknown[]
}
