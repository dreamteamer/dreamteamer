// Partial engine shapes for tier-1 tests. A unit test hands an engine function only the slice of a
// descriptor it reads ({ storage: { format: "md" } }), on purpose — these say so once, instead of a
// cast at every call site.
import type { Descriptor, Descriptors } from "../../src/types.ts"

/** A descriptor carrying only the keys the function under test reads. */
export const desc = (partial: Record<string, any>): Descriptor => partial as Descriptor

/** A name → descriptor map of partials, for functions that resolve across collections. */
export const descriptors = (entries: Iterable<readonly [string, Record<string, any>]>): Descriptors =>
  new Map(entries) as Descriptors
