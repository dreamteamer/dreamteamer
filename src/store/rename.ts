import { idsOf } from "../record/descriptor.ts"
import { patternRe } from "../record/records.ts"
import { placementOf, isNested, parentOfNestedId, placedRoot, localOfNestedId } from "../record/placement.ts"
import path from "node:path"
import { storageOf } from "../record/storageOf.ts"
import fs from "node:fs"
import { parseRecordText } from "../record/parseRecordText.ts"
import { bodyField } from "../record/bodyField.ts"
import { atomicWrite } from "../lib/atomicWrite.ts"
import { serialize } from "../record/serialize.ts"
import type { Store } from "./Store.ts"
import { recordFileName } from "./lib/recordFileName.ts"
import { pruneEmptyDirs } from "./lib/pruneEmptyDirs.ts"

export function rename(
  store: Store,
  collection: string,
  oldId: string,
  newId: string
): { id: string; rewrites: number; touched?: number; skipped?: number; ambiguous?: number } {
  const d = store.writableDescriptor(collection)
  store.assertUnambiguous(collection, oldId)
  store.read(collection, oldId) // existence check
  if (oldId === newId) return { id: newId, rewrites: 0 }
  if (idsOf(d).pattern && !patternRe(idsOf(d).pattern).test(newId)) {
    throw new Error(`id "${newId}" does not match pattern ${idsOf(d).pattern} — nothing was renamed.`)
  }
  const oldUnit = store.recordRoot(d, oldId) // folder-shape: move the WHOLE folder
  store._assertContained(d, oldUnit)
  // a placed record keeps the folder it is in: a rename changes the id, never the owner — except a
  // NESTED one, whose id begins with its parent's: renaming it to another parent moves it there
  const under = placementOf(d)
  const nested = isNested(under)
  const newParent = nested ? parentOfNestedId(newId) : null
  const parentChanged = nested && newParent !== parentOfNestedId(oldId)
  if (nested && !newId.includes("/"))
    throw new Error(
      `${collection}/${newId}: ids of ${collection} begin with their ${under.parent}'s id — nothing was renamed.`
    )
  if (parentChanged && !store.ids(under.collection).has(newParent))
    throw new Error(
      `${collection}/${newId}: there is no ${under.collection}/${newParent} to move it under — nothing was renamed.`
    )
  // ⚠ The destination is DERIVED, never looked up: recordRoot answers for a record that EXISTS —
  // from the index for an opaque one — so asking it for the new id threw "no such record" on every
  // rename of a `format: binary` record. The new unit is the write root's: the folder for a folder shape, the file otherwise — keeping the extension an opaque
  // record carries, which only its current file name knows.
  const newUnit = nested
    ? path.join(
        placedRoot(under, store.dir(d), store.parentDir(d), newParent),
        recordFileName(d, localOfNestedId(newId))
      )
    : placementOf(d)
      ? path.join(store.rootOfFile(d, oldUnit), recordFileName(d, newId))
      : storageOf(d).shape === "folder"
        ? path.join(store.dir(d), newId)
        : storageOf(d).format === "binary"
          ? path.join(store.dir(d), `${newId}.${storageOf(d).suffix}${path.extname(oldUnit)}`)
          : path.join(store.dir(d), recordFileName(d, newId))
  store._assertContained(d, newUnit)
  if (fs.existsSync(newUnit) || (placementOf(d) && store.ids(collection).has(newId)))
    throw new Error(`${collection}/${newId} already exists — nothing was renamed.`)
  return store.withWriteLock(() => {
    store._idsCache.delete(collection)
    // a folder-shape PARENT carries the records placed inside it along — their files move,
    // their ids do not, and their id memos are stale the moment the folder is
    store._dropPlacedUnder(collection)
    fs.mkdirSync(path.dirname(newUnit), { recursive: true })
    const oldBytes = parentChanged ? fs.readFileSync(oldUnit, "utf8") : null
    fs.renameSync(oldUnit, newUnit)
    // the owner field follows the id's new first segment, in the same write
    if (parentChanged) {
      const f = parseRecordText(oldBytes, d, bodyField(d))
      f[under.parent] = `${under.collection}/${newParent}`
      atomicWrite(newUnit, serialize(d, f, oldBytes))
    }
    pruneEmptyDirs(path.dirname(oldUnit), store.rootOfFile(d, oldUnit)) // cross-partition renames leave empty date dirs
    // rewrite inbound references (frontmatter/structured always; prose only via wikilinks). It
    // snapshots what it writes as it writes it — see rewriteRefs for why the caller cannot.
    const { touched, rewrites, skipped, ambiguous, restore } = store.rewriteRefs(
      `${collection}/${oldId}`,
      `${collection}/${newId}`
    )
    store.commit(
      [oldUnit, newUnit, ...touched],
      `dreamteamer: ${collection} rename ${oldId} → ${newId}`,
      () => {
        fs.mkdirSync(path.dirname(oldUnit), { recursive: true })
        fs.renameSync(newUnit, oldUnit)
        if (oldBytes !== null) atomicWrite(oldUnit, oldBytes)
        pruneEmptyDirs(path.dirname(newUnit), store.rootOfFile(d, newUnit))
        store._dropPlacedUnder(collection)
        restore()
      },
      storageOf(d).repo
    )
    // each entry names the PAIR it came from, because a batch has more than one — see rewriteRefsBatch
    for (const s of skipped) {
      console.warn(
        `⚠ ${path.relative(store.root, s.file)}: ${s.count} raw-prose occurrence(s) of ${s.oldRef} left untouched — only [[wikilinks]] are maintained in bodies (decision 7)`
      )
    }
    for (const a of ambiguous) {
      console.warn(
        `⚠ ${path.relative(store.root, a.file)}: ${a.count} bare [[${a.base}]] wikilink(s) left untouched — ${a.claimants.join(", ")} also ends in "${a.base}", so nothing here can tell which record the link means. Rewrite by hand, or spell it [[${a.newRef}]].`
      )
    }
    return { id: newId, rewrites, touched: touched.length, skipped: skipped.length, ambiguous: ambiguous.length }
  })
}
