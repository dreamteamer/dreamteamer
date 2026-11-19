import { storageOf } from "../record/storageOf.ts"
import type { Descriptors } from "../types.ts"

/**
 * The record layer a repo is, by name — what a descriptor's root carries — or null for the workspace
 * and for a module's clone that merely holds its own records.
 */
export function layerOf(descriptors: Descriptors, repo: string): string | null {
  for (const d of descriptors.values())
    for (const r of storageOf(d).roots) if (r.repo === repo && r.layer) return r.layer
  return null
}
