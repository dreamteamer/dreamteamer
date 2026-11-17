import { type Document, isMap, isNode, isScalar } from "yaml"
import { yamlOf } from "./yamlOf.ts"

/**
 * Change some top-level keys of a YAML text and leave every other character as it was written. A key owns the
 * lines from its own to the end of its value; comments and blank lines between keys stay where they are. A changed
 * key's lines are replaced, a removed key's dropped, a new key goes after the last one. Null when the text is not a
 * block map.
 */
export function editYaml(source: string, doc: Document, changes: [string, unknown][]): string | null {
  const map = doc.contents
  if (!isMap(map) || map.flow) return null
  const parts: { key?: string; text: string }[] = []
  let at = 0
  for (const item of map.items) {
    if (!isScalar(item.key) || !item.key.range) return null
    const start = source.lastIndexOf("\n", item.key.range[0] - 1) + 1
    const stop = isNode(item.value) && item.value.range ? item.value.range[2] : item.key.range[2]
    const end = stop > 0 && source[stop - 1] === "\n" ? stop : source.indexOf("\n", stop) + 1 || source.length
    if (start < at) return null
    if (start > at) parts.push({ text: source.slice(at, start) })
    parts.push({ key: String(item.key.value), text: source.slice(start, end) })
    at = end
  }
  const rest = source.slice(at)
  for (const [k, v] of changes) {
    const i = parts.findIndex((t) => t.key === k)
    if (v === undefined) {
      if (i >= 0) parts.splice(i, 1)
    } else if (i >= 0) parts[i].text = yamlOf({ [k]: v })
    else parts.splice(parts.findLastIndex((t) => t.key !== undefined) + 1, 0, { key: k, text: yamlOf({ [k]: v }) })
  }
  return parts.map((t) => (t.text.endsWith("\n") ? t.text : t.text + "\n")).join("") + rest
}
