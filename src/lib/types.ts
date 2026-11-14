/** Where a rename or a refusal touches a source: the file, the key path, and whether the walk rewrote it. */
export type Position = { rel: string; at: string; fixed: boolean; why?: string; label?: string }

/** A parsed YAML subtree a walker reads and rewrites in place. Its shape is the author's, so every walker
 *  checks a key's type before it trusts it — `asTree` is that check. */
export type Tree = Record<string, unknown>
