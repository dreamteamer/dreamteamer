import { readFileSync, statSync } from "node:fs"
import { type Document, parseDocument } from "yaml"
import { DtError } from "../lib/DtError.ts"
import { isObject } from "../lib/isObject.ts"
import { messageOf } from "../lib/messageOf.ts"
import { bodyField } from "../model/bodyField.ts"
import type { Collection } from "../types/Collection.ts"
import type { DtRecord } from "../types/DtRecord.ts"
import type { Model } from "../types/Model.ts"
import { locate } from "./locate.ts"

/** A record and the text it was read from, so that a rewrite can keep what it does not change. */
export function load(model: Model, ref: string) {
  const { c, id, path } = locate(model, ref)
  const mtimeMs = statSync(path).mtimeMs
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "")
  function fail(m: string) {
    return new DtError(`${c.name}/${id}: unreadable — ${m.split("\n")[0]}`)
  }
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
  const res: { rec: DtRecord; c: Collection; doc: Document | null; front: string; body: string } = {
    rec: { ref: `${c.name}/${id}`, collection: c.name, id, path, data, mtimeMs },
    c,
    doc,
    front,
    body,
  }
  return res
}
