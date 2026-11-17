import { type Document, parseDocument } from "yaml"
import { isObject } from "../lib/isObject.ts"
import { messageOf } from "../lib/messageOf.ts"
import { bodyField } from "../model/bodyField.ts"
import type { Collection } from "../types/Collection.ts"

/**
 * A record's fields from the text of its file, and the parts a rewrite keeps: the YAML document, the frontmatter and
 * the body. Text that cannot be read throws what `fail` makes of the reason.
 */
export function parseText(c: Collection, text: string, fail: (m: string) => Error) {
  /** the fields of a record: a map of names to values, or nothing at all */
  function fieldsOf(v: unknown): Record<string, unknown> {
    if (v === null || v === undefined) return {}
    if (isObject(v)) return v
    throw fail("its fields are not a map of names to values")
  }
  let doc: Document | null = null
  let body = ""
  let front = ""
  let data: Record<string, unknown>
  if (c.storage.format === "json") {
    let js: unknown
    try {
      js = JSON.parse(text)
    } catch (e) {
      throw fail(messageOf(e))
    }
    data = fieldsOf(js)
  } else {
    const md = c.storage.format === "md"
    const m = md ? /^---\r?\n(?:([\s\S]*?)\r?\n)?---\r?\n?([\s\S]*)$/.exec(text) : null
    body = md ? (m ? m[2] : text) : ""
    front = md ? (m && m[1] ? m[1] + "\n" : "") : text
    doc = parseDocument(front)
    if (doc.errors.length) throw fail(doc.errors[0].message)
    let js: unknown
    try {
      js = doc.toJS()
    } catch (e) {
      throw fail(messageOf(e))
    }
    data = fieldsOf(js)
    const bf = bodyField(c)
    if (bf && body.trim()) data[bf] = body
  }
  const res: { data: Record<string, unknown>; doc: Document | null; front: string; body: string } = {
    data,
    doc,
    front,
    body,
  }
  return res
}
