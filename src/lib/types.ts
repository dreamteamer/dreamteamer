/** Where a rename or a refusal touches a source: the file, the key path, and whether the walk rewrote it. */
export interface Position {
  rel: string
  at: string
  fixed: boolean
  why?: string
  label?: string
}

/** A parsed YAML subtree a walker reads and rewrites in place. Its shape is the author's, so every walker
 *  checks a key's type before it trusts it — `asTree` is that check. */
export type Tree = Record<string, unknown>

// A schema op returns a different shape per outcome (dry run · nothing to do · committed); a caller that
// reads whichever keys are there wants them as ONE type, each optional, each keeping its real type.
export type KeysOf<U> = U extends unknown ? keyof U : never

export type Flat<U> = { [K in KeysOf<U>]?: U extends Partial<Record<K, infer V>> ? V : never }
