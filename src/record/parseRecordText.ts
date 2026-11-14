import { storageOf } from "./storageOf.ts"
import { load } from "./yaml.ts"
import type { Descriptor, Fields } from "../types.ts"

export function parseRecordText(text: string, d: Descriptor, bodyField?: string | null): Fields {
  const format = storageOf(d).format
  if (format === "yaml") return load(text) ?? {}
  if (format === "json") return JSON.parse(text)
  let fields: Fields = {}
  let body = text
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (m) {
    fields = load(m[1]) ?? {}
    body = text.slice(m[0].length)
  }
  if (bodyField && body.trim()) fields[bodyField] = body
  return fields
}
