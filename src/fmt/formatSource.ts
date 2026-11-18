import { type YAMLMap, type YAMLSeq, isMap, isSeq, type Node, visit as visitYaml, parseDocument, type Pair } from "yaml"
import { emitDocument } from "../lib/emitDocument.ts"
import { keyOf } from "../lib/yaml.ts"

/**
 * A flow mapping, or a flow sequence holding a collection — the two flow forms block style replaces.
 * A flow sequence of scalars (`enum: [open, done]`) is block style's own short form and stays.
 */
const isFlowForm = (n: unknown): n is YAMLMap | YAMLSeq =>
  !!(n as { flow?: boolean })?.flow && (isMap(n) || (isSeq(n) && n.items.some(i => isMap(i) || isSeq(i))))

const holdsFlowForm = (node: Node): boolean => {
  let found = false
  visitYaml(node, {
    Node(_, n) {
      if (isFlowForm(n)) {
        found = true
        return visitYaml.BREAK
      }
    },
  })
  return found
}

/**
 * Block style, with the top-level keys in `order` (an unlisted key keeps its place after them).
 * Nothing below the top level is reordered, and every node whose style is already block keeps its
 * original bytes — so a second run returns its input unchanged. The comment block opening the file,
 * when a blank line separates it from the first key, stays at the top whatever key moves there.
 */
export function formatSource(text: string, order: string[]): string {
  const doc = parseDocument(text, { schema: "core" })
  const top = doc.contents
  if (!isMap(top)) return text
  const first = top.items[0]?.key
  const c = first?.commentBefore
  if (c?.includes("\n\n") && doc.commentBefore == null) {
    const at = c.lastIndexOf("\n\n")
    ;[doc.commentBefore, first.commentBefore] = [c.slice(0, at), c.slice(at + 2) || undefined]
  }
  const rank = (p: Pair<unknown, unknown>): number => {
    const i = order.indexOf(keyOf(p))
    return i === -1 ? order.length : i
  }
  top.items = [...top.items].sort((a, b) => rank(a) - rank(b))
  visitYaml(doc, {
    Node(_, n) {
      if (isFlowForm(n)) n.flow = false
    },
  })
  return emitDocument(doc, text, o => !holdsFlowForm(o as Node))
}
