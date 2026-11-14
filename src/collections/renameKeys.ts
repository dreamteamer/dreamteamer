import { parseDocument, isMap, type Pair, type Node } from "yaml"
import { keyOf } from "../record/yaml.ts"

/**
 * Rename mapping KEYS in place, in the bytes: each `{ path, to }` names a key by its path from the
 * document root (`['fields', 'status']`, `['constraints', 0, 'if', 'properties', 'status']`) and the
 * name it becomes. `writeSource` matches a mapping's pairs BY KEY, so a renamed key reads to it as one
 * pair removed and another added — and the comments inside the old pair would go with it. Renaming
 * the key token first, at its source range, keeps the pair: every comment, every flow form and every
 * byte around it stay exactly where they were. A path that names no key is skipped; the caller's
 * value-level write still lands, and its comment guard still holds.
 */
export function renameKeys(previousText: string, renames: { path: (string | number)[]; to: string }[]): string {
  const doc = parseDocument(previousText, { schema: "core" })
  const edits: [number, number, string][] = []
  for (const { path: at, to } of renames) {
    const parent = at.length > 1 ? doc.getIn(at.slice(0, -1), true) : doc.contents
    if (!isMap(parent)) continue
    const pair = (parent.items as Pair<Node>[]).find(p => keyOf(p) === String(at[at.length - 1]))
    if (!pair?.key?.range) continue
    const [s, e] = pair.key.range
    const raw = previousText.slice(s, e)
    const q = raw[0] === '"' || raw[0] === "'" ? raw[0] : ""
    edits.push([s, e, `${q}${to}${q}`])
  }
  let out = previousText
  for (const [s, e, text] of edits.sort((a, b) => b[0] - a[0])) out = out.slice(0, s) + text + out.slice(e)
  return out
}
