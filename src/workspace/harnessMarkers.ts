/** One flattened line of prose from a possibly-folded YAML scalar. */
export const flat = (s: unknown): string =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
