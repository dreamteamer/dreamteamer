import { type Document, isMap, isSeq, type Node, isScalar, parseDocument } from "yaml"
import { emitDocument } from "./emitDocument.ts"
import { dump, keyOf, same } from "./yaml.ts"

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v)

/**
 * Apply a plain JS value onto a parsed document, touching only the nodes that differ.
 *
 * Key ORDER comes from the value, which is what gives `add-field` its insert-before-body placement
 * for free; an existing key keeps its node — and therefore its comments, its quoting and its flow
 * form — whenever its value is unchanged. A node that IS replaced inherits the comments that sat on
 * the position, because those belong to the key, not to the value that happened to be there.
 */
function merge(doc: Document, node: unknown, value: unknown): unknown {
  if (isMap(node) && isObj(value)) {
    // an empty `{}` is a placeholder, not a style: whatever fills it is written block style
    if (node.flow && !node.items.length && Object.keys(value).length) node.flow = false
    node.items = Object.entries(value).map(([k, v]) => {
      const pair = node.items.find(p => keyOf(p) === k)
      if (!pair) return doc.createPair(k, v)
      pair.value = merge(doc, pair.value, v)
      return pair
    })
    return node
  }
  // ⚠ A SEQUENCE IS MATCHED BY VALUE FIRST, NEVER BY INDEX ALONE. A comment in a list belongs to the
  // ITEM it sits above, and index-matching hands it to whatever slides into that slot: dropping
  // `name` from `required: [name, vendor_code]` moved "name is required because…" on top of
  // `vendor_code` — an explanation attached to something it does not explain, which is worse than
  // losing it. So an unchanged item keeps its own node wherever it moved to; only what is left over
  // falls to the leftover nodes IN ORDER, which is what lets an in-place edit (an `x-reference`
  // retarget rewriting one entry) keep the comment that was always about that position.
  if (isSeq(node) && Array.isArray(value)) {
    const old = [...node.items] as (Node | undefined)[]
    const out = new Array(value.length)
    value.forEach((v, i) => {
      const j = old.findIndex(it => it !== undefined && same(it?.toJSON?.() ?? null, v ?? null))
      if (j !== -1) {
        out[i] = old[j]
        old[j] = undefined
      }
    })
    let k = 0
    value.forEach((v, i) => {
      if (out[i] !== undefined) return
      while (k < old.length && old[k] === undefined) k++
      out[i] = k < old.length ? merge(doc, old[k++], v) : doc.createNode(v)
    })
    node.items = out
    return node
  }
  if (isScalar(node) && !isObj(value) && !Array.isArray(value) && node.value === value) return node
  const fresh = doc.createNode(value)
  for (const k of ["comment", "commentBefore", "spaceBefore"] as const) {
    const was = (node as Partial<Record<typeof k, unknown>> | null)?.[k]
    if (was !== undefined) (fresh as Record<typeof k, unknown>)[k] = was
  }
  return fresh
}

/**
 * Serialize `value` back over the source it came from, keeping everything the change did not touch.
 *
 * `previousText` is the bytes on disk, or null for a file that does not exist yet — a new file has no
 * formatting to preserve and no comments to lose, so it is `dump`ed exactly as before.
 */
export function writeSource(previousText: string | null | undefined, value: unknown): string {
  if (previousText === null || previousText === undefined) return dump(value)
  const doc = parseDocument(previousText, { schema: "core" })
  doc.contents = merge(doc, doc.contents, value) as typeof doc.contents
  return emitDocument(doc, previousText)
}
