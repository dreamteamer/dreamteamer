import type { Fields } from "../types.ts"
import type { SourceDoc } from "../workspace/types.ts"

/** Where a rename or a refusal touches a source: the file, the key path, and whether the walk rewrote it. */
export type Position = { rel: string; at: string; fixed: boolean; why?: string; label?: string }

/** A parsed YAML subtree a walker reads and rewrites in place. Its shape is the author's, so every walker
 *  checks a key's type before it trusts it — `asTree` is that check. */
export type Tree = Record<string, unknown>

/** Reports one position a walk touched: its key path, why it was not rewritten, or the key it became. */
export type At = (label: string, why?: string, renamedTo?: string, keyPath?: (string | number)[]) => void

/** What a walk does at each source: its own descriptor, every other one, and each view or binding. */
export type SourceVisitor = {
  own: (doc: SourceDoc, at: At) => void
  foreign?: (doc: SourceDoc, at: At) => void
  view: (doc: SourceDoc, kind: string, at: At) => void
}

/** What a filter walk does at each condition: a field key, and a union reference it cannot follow. */
export type FilterVisitor = {
  field: (node: Tree, key: string, coll: string, at: At, label: string) => void
  union?: (cond: Tree, targets: string[], at: At, label: string) => void
}

/** A source a walk rewrites: its bytes before, the rewritten doc, and the keys renamed in place. */
export type SourceEdit = { before: string; doc: SourceDoc; keys: { path: (string | number)[]; to: string }[] }

/** A record a walk rewrites: its file, its new fields, and its bytes before. */
export type RecordRewrite = { file: string; fields: Fields; text: string }

export type Walk = { positions: Position[]; edits: Map<string, SourceEdit>; records: RecordRewrite[] }
