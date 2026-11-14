import { defaults } from "./descriptor.ts"
import type { Descriptor, DisplayBlock } from "../types.ts"

/** The display block, the authored keys over the defaults compile supplied, sub-block by sub-block. */
export function displayOf(d: Descriptor): DisplayBlock {
  const a = d?.display ?? {}
  const s = defaults(d).display ?? {}
  const out: Record<string, Record<string, unknown>> = {}
  for (const b of ["nav", "list", "record", "form"]) {
    const v = { ...(s[b] ?? {}), ...(a[b] ?? {}) }
    if (Object.keys(v).length) out[b] = v
  }
  return out
}
