/** Every leaf value at a field path, arrays flattened. */
export function* valuesAt(obj: unknown, fieldPath: string[]): Generator<unknown> {
  let vals: unknown[] = [obj]
  for (const key of fieldPath)
    vals = vals
      .flatMap(v => (Array.isArray(v) ? v : [v]))
      .flatMap(v => (v && typeof v === "object" ? [(v as Record<string, unknown>)[key]] : []))
  for (const v of vals.flat(Infinity)) if (v != null) yield v
}
