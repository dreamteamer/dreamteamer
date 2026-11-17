import type { Field } from "./Field.ts"

export interface Collection {
  name: string
  /** the name on the command line in the singular: authored, or inflected */
  singular: string
  module: string
  description?: string
  use_when?: string
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
  ids: { from: string[]; pattern?: string }
  fields: Record<string, Field>
  /** modules whose overlays or mixins contributed fields */
  contributors: string[]
}
