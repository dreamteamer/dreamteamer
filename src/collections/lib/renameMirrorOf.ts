import type { At } from "./types.ts"
import { targetsOf } from "../../record/descriptor.ts"
import type { Field } from "../../types.ts"
import type { SourceDoc } from "../../workspace/types.ts"

export function renameMirrorOf(doc: SourceDoc | null, collection: string, from: string, to: string, at: At): void {
  for (const [k, f] of Object.entries(doc?.fields ?? {}) as [string, Field][]) {
    const t = targetsOf(f)
    if (f?.mirror_of === from && Array.isArray(t) && t.length === 1 && t[0] === collection) {
      f.mirror_of = to
      at(`fields.${k}.mirror_of`)
    }
  }
}
