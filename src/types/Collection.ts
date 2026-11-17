import type { Field } from "./Field.ts"
import type { Rule } from "./Rule.ts"

export interface Collection {
  name: string
  /** the name on the command line in the singular: authored, or inflected */
  singular: string
  module: string
  description?: string
  use_when?: string
  /** the human label, as written; surfaces derive one from the name when it is absent */
  title?: string
  /** how one record is labelled, a template, as written */
  record_title?: string
  /** workspace plumbing rather than a domain noun */
  internal?: boolean
  /** records never leave the workspace through an export */
  sensitive?: boolean
  /** how surfaces draw it — `nav`, `list`, `record`, `form` — as written, each sub-block over its mixins' */
  display?: Record<string, unknown>
  /** rules across fields, as written: the descriptor's, then its mixins', then its overlays' */
  constraints?: Record<string, unknown>[]
  /** the same rules as read, which every write and check enforces; one that cannot be read is an error in the model */
  rules: Rule[]
  storage: {
    path: string
    /** md, yaml, json or binary; any other is an error in the model, and its records are read as YAML */
    format: string
    suffix: string
    shape?: string
    entry?: string
    /** the descriptor's other storage keys, carried as written */
    [key: string]: unknown
  }
  /** stored inside the folder of the record its `parent` field names (`storage.under`), at `subfolder` there */
  under?: { parent: string; subfolder: string; collection: string }
  ids: { from: string[]; pattern?: string }
  fields: Record<string, Field>
  /** modules whose overlays or mixins contributed fields */
  contributors: string[]
}
