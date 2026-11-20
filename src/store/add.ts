import type { Fields } from "../types.ts"
import { generateId } from "./lib/generateId.ts"
import { idsOf } from "../record/descriptor.ts"
import { patternRe } from "../record/records.ts"
import fs from "node:fs"
import { placementOf } from "../record/placement.ts"
import path from "node:path"
import { atomicWrite } from "../lib/atomicWrite.ts"
import { serialize } from "../record/serialize.ts"
import { storageOf } from "../record/storageOf.ts"
import { normalizeTemporal } from "./lib/normalizeTemporal.ts"
import type { Store } from "./Store.ts"

export function add(
  store: Store,
  collection: string,
  fields: Fields,
  { id: explicitId }: { id?: string } = {}
): {
  id: string
  file: string
  idFallback: { field?: string; value: string; id: string } | null
  deprecated?: string[]
} {
  const d = store.writableDescriptor(collection)
  // before validate: a mirror value is refused on its own terms, not as a schema error
  store.refuseMirrorWrites(collection, null, Object.keys(fields))
  store.refuseEngineWrites(d, Object.keys(fields))
  // descriptor v2: `created` is stamped here, before the id is made, so `ids.from` can name it
  if (d.compiled?.fields?.created) fields.created = nowStamp()
  const deprecated = Object.keys(fields).filter(k => d.compiled?.fields?.[k]?.deprecated)
  store.validate(d, fields)
  // the KEYS, not a copy of them: `generateId` iterates this once and only for a `{{ seq }}`
  // template, so materializing the whole id list was an O(N) allocation per add that almost
  // every collection threw away unread.
  // An id derived from a hash rather than from readable text is reported back to the caller, not
  // swallowed — see the `slug` filter's note. The write still happens: an id must be produced,
  // and refusing here would break every workspace whose values are not latin. What must not
  // happen is that nobody is told.
  let idFallback: { field: string; value: string; id: string } | null = null
  const id =
    explicitId ??
    generateId(idsOf(d).from ?? "{{ name | slug }}", fields, store.ids(collection).keys(), {
      onFallback: f => {
        idFallback = f
      },
    })
  if (idsOf(d).pattern && !patternRe(idsOf(d).pattern).test(id)) {
    throw new Error(`id "${id}" does not match pattern ${idsOf(d).pattern} — nothing was written.`)
  }
  // after the id is known: another root's record OF THIS ID does not take a unique value from it
  store.refuseDuplicateValues(d, collection, id, fields, Object.keys(fields))
  // The fields decide the folder for a placed collection (rootFor), and existence is asked of the
  // INDEX, not of one path: the same id already sitting under another parent is the duplicate
  // `check` would report, and refusing it here is what keeps the id unique across every root.
  const file = store.filePath(d, id, undefined, fields)
  store._assertContained(d, file)
  if (fs.existsSync(file) || (placementOf(d) && store.ids(collection).has(id)))
    throw new Error(`${collection}/${id} already exists — nothing was written.`)
  return store.withWriteLock(() => {
    // captured before the invalidation and handed back, one entry richer, on the success path
    // below — see _indexAdd for why an add that throws it away is the expensive shape.
    const memo = store._idsCache.get(collection)
    store._idsCache.delete(collection)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    atomicWrite(file, serialize(d, fields))
    // OWNER FIRST, then the mirrors, then undo the owner if they refuse. The order matters: the
    // mirror pass reads targets through `ids()`, and a relation whose target IS this collection
    // (a record linking to its own kind) has to be able to see the record it is attaching. The
    // alternative — a dry pass that computes the edits without writing them — is the same loop
    // twice to save one `rmSync`, and two copies of it is how the two would drift apart.
    let mirrors
    try {
      mirrors = store.applyMirrorEdits(d, id, null, fields, file)
    } catch (e) {
      fs.rmSync(file, { force: true })
      store._pruneAround(d, file)
      // ⚠ AND THE MEMO, or the removal is only half done. applyMirrorEdits reads targets through
      // `ids()`, so a relation whose target is this same collection re-cached it WITH the record
      // just written — and the memo key (HEAD + the collection's TOP directory mtime) does not
      // move for a record created and removed inside an existing sub-directory. This Store then
      // lists an id that is not on disk, and the next write's checkRefs accepts a reference to
      // it: a verb reporting success and landing a dangling ref.
      store._idsCache.delete(collection)
      throw e // applyMirrorEdits already undid its own partial work — "nothing was written" is true again
    }
    // ONE commit, owner and mirrors together: a commit where only half a relation moved is a
    // history that never held a consistent workspace.
    store.commit(
      [file, ...mirrors.files],
      `dreamteamer: ${collection} add ${id}`,
      () => {
        mirrors.undo()
        fs.rmSync(file, { force: true })
        store._pruneAround(d, file)
        store._idsCache.delete(collection) // same phantom as the catch above — see the note there
      },
      storageOf(d).repo
    )
    // LAST, after the commit: the key it is re-stated under carries the sha, and `commit` moves it
    store._indexAdd(collection, memo, id, file)
    return { id, file, idFallback, ...(deprecated.length ? { deprecated } : {}) }
  })
}

function nowStamp() {
  const t = new Date()
  const p = (n: number): string => String(n).padStart(2, "0")
  return normalizeTemporal(
    `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}T${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`,
    "date-time"
  )
}
