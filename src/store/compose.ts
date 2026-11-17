import type { Collection } from "../types/Collection.ts"

/** the whole text of a record's file, from its frontmatter, its fields and its body */
export function compose(c: Collection, yaml: string, data: Record<string, unknown>, body: string): string {
  if (c.storage.format === "json") return JSON.stringify(data, null, 2) + "\n"
  return c.storage.format === "md" ? `---\n${yaml}---\n${body}` : yaml
}
