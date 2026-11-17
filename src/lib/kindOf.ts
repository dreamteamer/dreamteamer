/** what a value read from disk is, for a message: "text", "a number", "a list", "a map", "nothing" */
export function kindOf(v: unknown): string {
  if (v === null || v === undefined) return "nothing"
  if (Array.isArray(v)) return "a list"
  if (typeof v === "object") return "a map"
  return typeof v === "string" ? "text" : `a ${typeof v}`
}
