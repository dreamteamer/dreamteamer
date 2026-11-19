import type { ExportChange } from "../record/types.ts"

/** A manifest is stale exactly when `regenerate` would change or drop one of its existing entries. */
export const isStale = (changes: ExportChange[]): boolean => changes.some(c => c.kind !== "add")
