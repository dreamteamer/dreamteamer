import type { Fields } from "../types.ts"
import { storageOf } from "../record/storageOf.ts"
import { placementOf, isNested, localOfNestedId } from "../record/placement.ts"
import fs from "node:fs"
import path from "node:path"
import { atomicWrite } from "../lib/atomicWrite.ts"
import { serialize } from "../record/serialize.ts"
import type { Store } from "./Store.ts"
import type { Undo } from "./types.ts"

export function set(store: Store, collection: string, id: string, changes: Fields): { id: string; file: string } {
  const d = store.writableDescriptor(collection)
  // first: on a file record every field is read from the file, so the answer is the replacement
  if (storageOf(d).format === "binary") {
    throw new Error(
      `${collection}/${id} is a file record — its fields are derived from the file, so there is nothing to set. Replace it with \`dreamteamer add ${collection} ${id} --from <path> --force\`.`
    )
  }
  store.refuseMirrorWrites(collection, id, Object.keys(changes))
  store.refuseEngineWrites(d, Object.keys(changes))
  store.assertUnambiguous(collection, id)
  const { fields, file } = store.read(collection, id)
  const nestedUnder = placementOf(d)
  if (
    isNested(nestedUnder) &&
    Object.hasOwn(changes, nestedUnder.parent) &&
    changes[nestedUnder.parent] !== fields[nestedUnder.parent]
  ) {
    throw new Error(
      `${collection}/${id}: ids of ${collection} begin with their ${nestedUnder.parent}'s id, so changing ${nestedUnder.parent} changes the id — rename it instead: dreamteamer rename ${collection}/${id} <new parent id>/${localOfNestedId(id)}. nothing was written.`
    )
  }
  const previous = fs.readFileSync(file, "utf8")
  const next = { ...fields, ...changes }
  for (const [k, v] of Object.entries(changes)) if (v === null || v === "") delete next[k]
  store.validate(d, next)
  store.refuseDuplicateValues(d, collection, id, next, Object.keys(changes))
  // A placed record FOLLOWS ITS OWNER FIELD: changing it moves the file to the new parent's folder
  // (or back to the fallback root) in this same write, id unchanged. Only a change to THAT field
  // moves anything — a record found in the wrong folder stays there when some other field is
  // edited, and `check` keeps reporting the mismatch until `relocate` is asked. Moving it as a
  // side effect of an unrelated edit would make a rename of a meeting relocate a file nobody
  // mentioned, in a commit whose subject says otherwise.
  store._assertContained(d, file) // the existing file, not only a new destination (R2b)
  const target = store.ownerChanged(d, fields, next) ? store.filePath(d, id, undefined, next) : file
  if (target !== file) store._assertContained(d, target)
  if (target !== file && fs.existsSync(target))
    throw new Error(`${collection}/${id}: ${path.relative(store.root, target)} already exists — nothing was written.`)
  return store.withWriteLock(() => {
    store._idsCache.delete(collection)
    // ONE rollback boundary for the bytes, the move and the mirrors (R1): the field write used to
    // sit before the move and outside any try, so a rename refused by the filesystem left a file
    // in the OLD folder saying it belonged to the NEW owner — a record `check` reports and a
    // verb that threw. Whatever fails, `undo` puts the original bytes back where they were.
    let unmove: Undo | null = null
    const undo = () => {
      unmove?.()
      atomicWrite(file, previous)
    }
    try {
      atomicWrite(file, serialize(d, next, previous))
      if (target !== file) unmove = store._moveRecord(d, file, target)
    } catch (e) {
      undo()
      throw e
    }
    // `fields` is the record as it was ON DISK and `next` as it will be, which is exactly the
    // before/after pair a mirror edit is: an FK that moved detaches from the old target and
    // attaches to the new one, in this same write. Same ordering as `add` — see the note there.
    let mirrors
    try {
      mirrors = store.applyMirrorEdits(d, id, fields, next, file)
    } catch (e) {
      undo()
      throw e
    }
    // both paths of a move, so a commit stages the deletion and the addition together
    store.commit(
      [target, ...(unmove ? [file] : []), ...mirrors.files],
      `dreamteamer: ${collection} set ${id}`,
      () => {
        mirrors.undo()
        undo()
      },
      store.repoOfFile(d, file)
    )
    return { id, file: target }
  })
}
