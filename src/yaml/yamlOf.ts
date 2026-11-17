import { Document, visit } from "yaml"

const DATEISH = /^\d{4}-\d{2}-\d{2}([Tt\s]|$)/

/** a value as a YAML node, quoting what a YAML 1.1 reader would take for a timestamp, as the released engine's files do */
function nodeOf(doc: Document, v: unknown) {
  const node = doc.createNode(v)
  visit(node, {
    Scalar(_k, n) {
      if (typeof n.value === "string" && DATEISH.test(n.value)) n.type = "QUOTE_SINGLE"
    },
  })
  return node
}

/** fields as the lines of a YAML map; nothing for no fields */
export function yamlOf(fields: Record<string, unknown>): string {
  const doc = new Document({})
  for (const [k, v] of Object.entries(fields)) doc.set(k, nodeOf(doc, v))
  const text = doc.toString({ lineWidth: 0, flowCollectionPadding: false })
  return text === "{}\n" ? "" : text
}
