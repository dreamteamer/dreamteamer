import { bodyField } from "./bodyField.ts"
import { storageOf } from "./storageOf.ts"
import { writeSource } from "../lib/writeSource.ts"
import { dump } from "../lib/yaml.ts"
import type { Descriptor, Fields } from "../types.ts"

export function serialize(d: Descriptor, fields: Fields, previousText?: string): string {
  const format = storageOf(d).format
  if (format === "json") return JSON.stringify(fields, null, 2) + "\n"
  if (format === "yaml") return dump(fields)
  const bf = bodyField(d)
  const fm = { ...fields }
  let body = ""
  if (bf && fm[bf] !== undefined) {
    body = String(fm[bf]).trim()
    delete fm[bf]
  }
  // ⚠ BYTE-RESTORING WHEN WE HAVE THE PREVIOUS TEXT (issue 2026-08-31). Building the whole document
  // from the parsed fields means a one-field `dt set` re-emits every key — so quoting, key order and
  // any hand-folded scalar are normalised, and the diff a human reviews is the whole record rather
  // than the change. `writeSource` restores every unchanged node from the bytes it was parsed out
  // of; only the mutated ones are re-emitted.
  //
  // ⚠ AND IT COSTS A SECOND PARSE PER WRITE. `parseDocument` twice is heavier than js-yaml, so the
  // third argument is passed by `set` ALONE — the one write where a previous document exists and
  // the diff is what the operator reads. Every other caller hits the `dump` path unchanged.
  const frontText =
    previousText === undefined
      ? dump(fm)
      : `${writeSource(frontMatterOf(previousText) ?? "", fm).replace(/\n+$/, "")}\n`
  return `---\n${frontText}---\n${body ? body + "\n" : ""}`
}

/** The YAML between the `---` fences, or null when the text has none. */
function frontMatterOf(text: string): string | null {
  return /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text))?.[1] ?? null
}
