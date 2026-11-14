import path from "node:path"
import fs from "node:fs"
import type { ErrorObject } from "ajv"
import { isBinary, storedFieldsOf } from "./descriptor.ts"
import { parseRecordText } from "./parseRecordText.ts"
import { storageOf } from "./storageOf.ts"
import type { Descriptor, Fields } from "../types.ts"

export function parseRecord(file: string, d: Descriptor, bodyField?: string | null): Fields {
  // An opaque record IS its bytes: there is nothing to parse, and reading a PNG as utf8 would
  // corrupt it on the way back out. What a reader gets instead is derived from the file itself.
  if (storageOf(d).format === "binary") {
    return { ext: path.extname(file).slice(1).toLowerCase(), bytes: fs.statSync(file).size }
  }
  return parseRecordText(fs.readFileSync(file, "utf8"), d, bodyField)
}

// id patterns may use unicode property escapes — compile with the u flag
export function patternRe(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "u")
  } catch {
    return new RegExp(pattern)
  }
}

// ajv errors, humanized: echo the offending value (the one datum the reader needs)
export function fmtAjvError(e: ErrorObject, fields: unknown): string {
  const fieldPath = e.instancePath.slice(1).replace(/\//g, ".")
  const value = fieldPath
    ? fieldPath.split(".").reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], fields)
    : undefined
  if (e.keyword === "enum") return `field ${fieldPath}: "${value}" not in enum [${e.params.allowedValues.join(", ")}]`
  return `field ${fieldPath || "(root)"}: ${JSON.stringify(value) ?? ""} ${e.message}`.trim()
}

// keys a record carries that its collection does not store (typo detector)
export function unknownFields(d: Descriptor, fields: Fields): string[] {
  if (isBinary(d)) return [] // a file record's fields are read from the file, never authored
  const props = storedFieldsOf(d)
  if (!Object.keys(props).length) return []
  return Object.keys(fields).filter(k => !(k in props))
}

// ids are PATHS — but only downward ones. traversal segments, absolute paths and
// backslashes are rejected before any fs join (review finding 1: an escaping --id
// wrote a record outside the repo and orphaned others inside it).
export function assertSafeId(id: unknown): asserts id is string {
  if (typeof id !== "string" || id === "") throw new Error(`invalid id "${id}" — nothing was written.`)
  if (id.startsWith("/") || id.includes("\\") || id.split("/").some(s => s === "" || s === "." || s === "..")) {
    throw new Error(
      `invalid id "${id}" — ids are relative paths, no "."/".." segments, no leading slash. nothing was written.`
    )
  }
}
