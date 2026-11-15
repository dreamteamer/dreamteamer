import { commitArg } from "../lib/git/commitArg.ts"
import { storageOf } from "../record/storageOf.ts"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { QUIET } from "../lib/consts.ts"
import fs from "node:fs"
import { parseRecordText } from "../record/parseRecordText.ts"
import { bodyField } from "../record/bodyField.ts"
import { atomicWrite } from "../lib/atomicWrite.ts"
import type { Store } from "./Store.ts"
import type { Undo } from "./types.ts"

export function revert(
  store: Store,
  collection: string,
  id: string,
  hash: string
): { id: string; reverted: boolean; hash?: string; file?: string } {
  commitArg(hash)
  const d = store.writableDescriptor(collection)
  store.assertUnambiguous(collection, id)
  const { fields: currentFields, file } = store.read(collection, id)
  if (storageOf(d).external)
    throw new Error(
      `${collection}/${id} is kept under ${storageOf(d).path}, outside every git repo here — there is no revision to revert to. nothing was reverted.`
    )
  // A placed record may have sat in ANOTHER parent's folder at `hash` — the move is what is being
  // reverted — so the historical path is looked up in that commit's tree, not assumed to be today's.
  // `<rev>:<path>` takes `/` on every OS — Windows' path.relative spells it with `\`
  // in the repo that holds the FILE — a layer record's history is in the layer's clone
  const fileRepo = path.resolve(store.root, store.repoOfFile(d, file))
  const relPath = store.pathAt(d, id, hash) ?? path.relative(fileRepo, file).split(path.sep).join("/")
  let previousContent
  try {
    previousContent = execFileSync("git", ["show", "--end-of-options", `${hash}:${relPath}`], {
      cwd: fileRepo,
      stdio: QUIET,
    }).toString()
  } catch {
    throw new Error(`${collection}/${id}: no content at ${hash} for ${relPath} — nothing was reverted.`)
  }
  const current = fs.readFileSync(file, "utf8")
  if (current === previousContent) return { id, reverted: false }
  // parse + validate the historical content before it touches disk
  const tmpFields = parseRecordText(previousContent, d, bodyField(d))
  // Snapshot BEFORE validate(), which qualifies bare refs in place. The mirror pass has to see
  // the record as the restored BYTES spell it — revert writes historical content verbatim, which
  // is the whole point of a revert — because `check` re-reads that file and expects a mirror only
  // for a ref it can parse. Qualifying `after` here would attach a mirror check then calls stale.
  const restored = { ...tmpFields }
  store.validate(d, tmpFields)
  // Restoring an owner field restores its PLACEMENT too — the historical record lived where its
  // historical owner put it, and writing it into whatever folder the record sits in today would
  // leave a file `check` reports the moment it lands. Same rule as `set`: only the owner moves it.
  store._assertContained(d, file)
  const target = store.ownerChanged(d, currentFields, tmpFields) ? store.filePath(d, id, undefined, tmpFields) : file
  if (target !== file) store._assertContained(d, target)
  if (target !== file && fs.existsSync(target))
    throw new Error(`${collection}/${id}: ${path.relative(store.root, target)} already exists — nothing was reverted.`)
  return store.withWriteLock(() => {
    store._idsCache.delete(collection) // every mutation drops the memo — cleared even if the commit rolls back
    let unmove: Undo | null = null
    const undo = () => {
      unmove?.()
      atomicWrite(file, current)
    }
    try {
      atomicWrite(file, previousContent)
      if (target !== file) unmove = store._moveRecord(d, file, target)
    } catch (e) {
      undo()
      throw e
    }
    // revert is SET-shaped — it changes the owner's foreign key — so the mirrors move with it.
    // Skipping this left BOTH targets stale: the restored one never got its link back, and the
    // abandoned one kept a link the owner no longer claims. Same ordering as `add`, see there.
    let mirrors
    try {
      mirrors = store.applyMirrorEdits(d, id, currentFields, restored, file)
    } catch (e) {
      undo()
      throw e
    }
    store.commit(
      [target, ...(unmove ? [file] : []), ...mirrors.files],
      `dreamteamer: ${collection} revert ${id} to ${String(hash).slice(0, 7)}`,
      () => {
        mirrors.undo()
        undo()
      },
      store.repoOfFile(d, file)
    )
    return { id, reverted: true, hash, file: target }
  })
}
