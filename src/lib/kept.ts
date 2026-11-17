/** the keys of a map that have a value, a list counting as one only when it is not empty */
export function kept(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length)))
}
