import type { ExportEntry, ExportsContext } from "./types.ts"

/**
 * Does this context read the entry's holder for its collection — a root of that collection, on disk,
 * whose package is the entry's `from`? An entry with no holder is seen by no context.
 */
export function sees(entry: ExportEntry | null | undefined, coll: string, ctx: ExportsContext): boolean {
  return !!entry?.from && ctx.rootsOf(coll).some(r => r.present && r.package === entry.from)
}
