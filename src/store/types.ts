import type { Storage } from "../types.ts"

/** One root a collection's records are read from, resolved: the compiled root plus its absolute path. */
export type ResolvedRoot = Storage["roots"][number] & { abs: string }

export type Undo = () => void

/** What a reference rewrite did: the files it wrote, the count, the occurrences it left (`skipped`: in
 *  text it does not rewrite; `ambiguous`: a bare `[[base]]` more than one record answers), and its undo. */
export interface RewriteResult {
  touched: string[]
  rewrites: number
  skipped: { file: string; count: number; oldRef: string; newRef: string }[]
  ambiguous: { file: string; count: number; base: string; claimants: string[]; oldRef: string; newRef: string }[]
  restore: Undo
}

/** What `relocatePlan` and `relocate` answer; `why` is `to-root` only for the internal `toRoot` reverse. */
export interface RelocatePlan<W = "placement" | "shape"> {
  collection: string
  moves: { id: string; from: string; to: string; why: W }[]
  problems: string[]
}
