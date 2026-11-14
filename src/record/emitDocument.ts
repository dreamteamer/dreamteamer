import { type Document, parseDocument, isMap, isSeq, isScalar, type Node, type Pair } from "yaml"
import { SOURCE_OPTS, commentLines, keyOf, nodeSpan, pairSpan, same } from "./yaml.ts"

/** Emit the document, restoring the original bytes of everything that did not change and that
 *  `keep` accepts — a formatter passes a `keep` that refuses a node whose STYLE it changed. */
export function emitDocument(
  doc: Document,
  originalText: string | null | undefined,
  keep: (o: unknown) => boolean = () => true
) {
  const out = doc.toString(SOURCE_OPTS)
  if (originalText == null) return out
  const oldRoot = parseDocument(originalText, { schema: "core" }).contents
  const newRoot = parseDocument(out, { schema: "core" }).contents
  const kind = (x: unknown): string | null => (isMap(x) ? "map" : isSeq(x) ? "seq" : isScalar(x) ? "scalar" : null)
  const edits: [number, number, string][] = []

  const visit = (o: Node | null | undefined, n: Node | null | undefined): void => {
    if (!o?.range || !n?.range || kind(o) === null || kind(o) !== kind(n)) return
    if (keep(o) && same(o.toJSON(), n.toJSON())) {
      const lines = commentLines(o)
      edits.push([...nodeSpan(out, n, lines), originalText.slice(...nodeSpan(originalText, o, lines))])
      return
    }
    // A changed collection is still mostly unchanged — descend, so one edited field restores every
    // sibling verbatim instead of re-emitting the whole block around it.
    if (isMap(o) && isMap(n)) {
      for (const np of n.items as Pair<Node, Node>[]) {
        const op = (o.items as Pair<Node, Node>[]).find(p => keyOf(p) === keyOf(np))
        if (!op) continue
        if (keep(op.value) && same(op.value?.toJSON?.() ?? null, np.value?.toJSON?.() ?? null)) {
          const lines = commentLines(op.value)
          edits.push([...pairSpan(out, np, lines), originalText.slice(...pairSpan(originalText, op, lines))])
        } else visit(op.value, np.value)
      }
    } else if (isSeq(o) && isSeq(n)) {
      for (let i = 0; i < Math.min(o.items.length, n.items.length); i++) visit(o.items[i] as Node, n.items[i] as Node)
    }
  }
  visit(oldRoot, newRoot)

  // right-to-left, so an earlier splice cannot shift a later one's offsets. Descending into a node
  // only happens when it was NOT spliced, so no two spans overlap.
  let res = out
  for (const [s, e, src] of edits.sort((a, b) => b[0] - a[0])) res = res.slice(0, s) + src + res.slice(e)
  // ⚠ FAIL CLOSED. Splicing bytes is only safe because it is checked: if the result does not parse
  // back to exactly the document that was asked for, the plain stringify is returned instead — a
  // reformatted file rather than a wrong one.
  try {
    if (!same(parseDocument(res, { schema: "core" }).toJS(), doc.toJS())) return out
  } catch {
    return out
  }
  return res
}
