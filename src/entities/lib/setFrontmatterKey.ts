import { writeSource } from "../../lib/writeSource.ts"
import { load } from "../../lib/yaml.ts"
import type { SourceDoc } from "../../workspace/types.ts"

/**
 * One frontmatter key, set (or removed with `null`), with the BODY untouched.
 *
 * ⚠ Round-tripped through `writeSource` over the frontmatter block ALONE, and the body re-attached
 * verbatim. Re-dumping a whole markdown file is how a skill's prose gets re-wrapped by a verb that
 * was asked to change one word of its description — and a skill's prose is the entire artifact.
 */
export function setFrontmatterKey(text: string, key: string, value: unknown): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n[\s\S]*)?$/.exec(text)
  if (!m) throw new Error("no YAML frontmatter — a markdown entity starts with a `---` block, and this file does not.")
  const doc = load<SourceDoc | null>(m[1]) ?? {}
  if (value === null) delete doc[key]
  else doc[key] = value
  const front = writeSource(m[1], doc).replace(/\n+$/, "")
  return `---\n${front}\n---${m[2] ?? "\n"}`
}
