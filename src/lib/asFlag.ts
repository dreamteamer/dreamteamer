/** a flag as this engine has always read one: set by any value but false, 0, empty text or null; undefined when absent */
export function asFlag(v: unknown): boolean | undefined {
  return v === undefined ? undefined : Boolean(v)
}
