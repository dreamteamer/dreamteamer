import type { ExportEntry, ExportsContext } from "./types.ts"

export const EXPORTS_FILE = "dreamteamer-exports.json"

/** Every leaf value at a field path, arrays flattened. */
export function* valuesAt(obj: unknown, fieldPath: string[]): Generator<unknown> {
  let vals: unknown[] = [obj]
  for (const key of fieldPath)
    vals = vals
      .flatMap(v => (Array.isArray(v) ? v : [v]))
      .flatMap(v => (v && typeof v === "object" ? [(v as Record<string, unknown>)[key]] : []))
  for (const v of vals.flat(Infinity)) if (v != null) yield v
}

/** Does this context read the entry's holder for its collection — a root of that collection, on disk,
 *  whose package is the entry's `from`? An entry with no holder is seen by no context. */
export function sees(entry: ExportEntry | null | undefined, coll: string, ctx: ExportsContext): boolean {
  return !!entry?.from && ctx.rootsOf(coll).some(r => r.present && r.package === entry.from)
}
