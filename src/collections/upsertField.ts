import fs from "node:fs"
import path from "node:path"
import { placeField } from "./placeField.ts"
import { canonical, compileGated } from "./schema-ops.ts"
import type { Store } from "../record/Store.ts"
import { writeSource } from "../record/writeSource.ts"
import { load } from "../record/yaml.ts"
import type { Field, Workspace } from "../types.ts"
import type { SourceDoc } from "../workspace/types.ts"
import { writeGated } from "../workspace/writeGated.ts"

export function upsertField(
  ws: Workspace,
  store: Store,
  collection: string,
  fieldName: string,
  field: Field,
  verb: string,
  { file: dest, overlay }: { file: string; overlay?: boolean }
) {
  if (field == null || typeof field !== "object" || Array.isArray(field)) {
    throw new Error(
      `field "${fieldName}" must be a map of field keys (got ${Array.isArray(field) ? "a list" : typeof field}) — nothing was written.`
    )
  }
  // The BYTES, not just the parse: `dump` cannot round-trip a comment, and a collection descriptor is
  // where a module writes down why the collection exists (see writeSource).
  const previousText = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : null
  let doc
  if (previousText !== null) doc = load<SourceDoc | null>(previousText)
  // Reached when no source this workspace may rewrite declares the collection — an npm-shipped or
  // engine-contributed one. An overlay in the workspace module is the remedy, and compile still
  // requires that module to declare the base's in its dependencies.
  else if (overlay) doc = { name: collection, overlay: true, fields: {} }
  else
    throw new Error(
      `${path.relative(ws.root, dest)} is named by the compiled manifest but is not on disk — run \`dreamteamer compile\` and re-run.`
    )
  // AN IDEMPOTENT WRITE IS A SUCCESS — a re-run of an "apply my schema" script, or a retry after a
  // partial failure, asks for what is already there. Say so plainly and stop, without a commit; but
  // still through the compile, so a broken workspace fails exactly as the gate fails it.
  const already = doc.fields?.[fieldName]
  if (already !== undefined && canonical(already) === canonical(field)) {
    compileGated(ws, store)
    return { collection, field: fieldName, file: dest, overlay, value: already, unchanged: true }
  }
  const gate = writeGated(ws, store, [dest], `dreamteamer: ${collection} ${verb}`, () => {
    doc.fields = placeField(doc.fields ?? {}, fieldName, field)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, writeSource(previousText, doc))
  })
  return { collection, field: fieldName, file: dest, overlay, value: field, commits: gate.commits }
}
