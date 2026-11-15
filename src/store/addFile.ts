import { storageOf } from "../record/storageOf.ts"
import { assertSafeId, patternRe } from "../record/records.ts"
import { idsOf } from "../record/descriptor.ts"
import path from "node:path"
import fs from "node:fs"
import { MAX_RECORD_BYTES } from "../record/consts.ts"
import type { Store } from "./Store.ts"
import { snapshot } from "./lib/snapshot.ts"

export function addFile(
  store: Store,
  collection: string,
  id: string,
  srcPath: string,
  { force = false } = {}
): { id: string; file: string } {
  const d = store.writableDescriptor(collection)
  if (storageOf(d).format !== "binary")
    throw new Error(
      `"${collection}" is not a \`format: binary\` collection — add its records with --<field> values, not --from`
    )
  assertSafeId(id)
  if (idsOf(d).pattern && !patternRe(idsOf(d).pattern).test(id)) {
    throw new Error(`id "${id}" does not match pattern ${idsOf(d).pattern} — nothing was written.`)
  }
  const ext = path.extname(srcPath).slice(1).toLowerCase()
  if (!ext) throw new Error(`${srcPath} has no extension — a file record is named by one. Nothing was written.`)
  const allowed = storageOf(d).accept
  if (allowed && !allowed.includes(ext))
    throw new Error(
      `"${collection}" does not accept .${ext} — its declared extensions are ${allowed.join(", ")}. Nothing was written.`
    )
  const size = fs.statSync(srcPath).size
  const max = storageOf(d).max_bytes ?? MAX_RECORD_BYTES
  if (size > max)
    throw new Error(
      `${srcPath} is ${size} bytes, over "${collection}"'s max_bytes of ${max} — a record is a small file. Nothing was written.`
    )
  const existing = store.ids(collection).get(id)
  if (existing && !force)
    throw new Error(`${collection}/${id} already exists — pass --force to replace it. Nothing was written.`)
  const file = store.filePath(d, id, ext)
  return store.withWriteLock(() => {
    store._idsCache.delete(collection)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // A replacement whose extension changed would otherwise leave its predecessor behind, and
    // two files under one id is the ambiguity `check` reports. One id is one file.
    const stale = existing && existing !== file ? existing : null
    const restore = snapshot([file, ...(stale ? [stale] : [])])
    if (stale) fs.rmSync(stale, { force: true })
    fs.copyFileSync(srcPath, file)
    store.commit([file, ...(stale ? [stale] : [])], `dreamteamer: ${collection} add ${id}`, restore, storageOf(d).repo)
    return { id, file }
  })
}
