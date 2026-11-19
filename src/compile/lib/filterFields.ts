/**
 * The field names a filter conditions on at its top level, through `_and` / `_or`. A nested
 * non-operator key is a field of the referenced record, which only that collection can judge.
 */
export function filterFields(filter: unknown): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(filter ?? {})) {
    if (k === "_and" || k === "_or") {
      for (const c of Array.isArray(v) ? v : []) out.push(...filterFields(c))
      continue
    }
    if (!k.startsWith("_")) out.push(k)
  }
  return out
}
