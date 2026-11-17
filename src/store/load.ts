import { readFileSync, statSync } from "node:fs"
import type { Document } from "yaml"
import { DtError } from "../lib/DtError.ts"
import type { Collection } from "../types/Collection.ts"
import type { DtRecord } from "../types/DtRecord.ts"
import type { Model } from "../types/Model.ts"
import { locate } from "./locate.ts"
import { parseText } from "./parseText.ts"

/** A record and the text it was read from, so that a rewrite can keep what it does not change. */
export function load(model: Model, ref: string) {
  const { c, id, path } = locate(model, ref)
  const mtimeMs = statSync(path).mtimeMs
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "")
  const { data, doc, front, body } = parseText(
    c,
    text,
    (m) => new DtError(`${c.name}/${id}: unreadable — ${m.split("\n")[0]}`),
  )
  const res: { rec: DtRecord; c: Collection; doc: Document | null; front: string; body: string } = {
    rec: { ref: `${c.name}/${id}`, collection: c.name, id, path, data, mtimeMs },
    c,
    doc,
    front,
    body,
  }
  return res
}
