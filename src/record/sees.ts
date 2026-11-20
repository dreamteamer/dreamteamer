import type { ExportEntry, ExportsContext } from "./types.ts"

/**
 * Does this context read the entry's holder for its collection — is the holder this workspace, and does
 * it have the collection? An entry with no holder is seen by no context.
 */
export function sees(entry: ExportEntry | null | undefined, coll: string, ctx: ExportsContext): boolean {
  return !!entry?.from && entry.from === ctx.own && ctx.reads(coll)
}
