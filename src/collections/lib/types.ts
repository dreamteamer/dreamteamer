import type { Fields } from "../../types.ts"
import type { SourceDoc } from "../../workspace/types.ts"
import type { Tree, Position } from "../../lib/types.ts"

/** Reports one position a walk touched: its key path, why it was not rewritten, or the key it became. */
export type At = (label: string, why?: string, renamedTo?: string, keyPath?: (string | number)[]) => void

/** What a walk does at each source: its own descriptor, every other one, and each view or binding. */
export interface SourceVisitor {
  own: (doc: SourceDoc, at: At) => void
  foreign?: (doc: SourceDoc, at: At) => void
  view: (doc: SourceDoc, kind: string, at: At) => void
}

/** What a filter walk does at each condition: a field key, and a union reference it cannot follow. */
export interface FilterVisitor {
  field: (node: Tree, key: string, coll: string, at: At, label: string) => void
  union?: (cond: Tree, targets: string[], at: At, label: string) => void
}

/** A source a walk rewrites: its bytes before, the rewritten doc, and the keys renamed in place. */
export interface SourceEdit {
  before: string
  doc: SourceDoc
  keys: { path: (string | number)[]; to: string }[]
}

/** A record a walk rewrites: its file, its new fields, and its bytes before. */
export interface RecordRewrite {
  file: string
  fields: Fields
  text: string
}

export interface Walk {
  positions: Position[]
  edits: Map<string, SourceEdit>
  records: RecordRewrite[]
}
