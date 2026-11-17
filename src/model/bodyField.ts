import type { Collection } from "../types/Collection.ts"

/** the field that is the text below a Markdown record's frontmatter */
export function bodyField(c: Collection): string | undefined {
  return Object.keys(c.fields).find((t) => c.fields[t].body)
}
