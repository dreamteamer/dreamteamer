import { parseRef } from "../record/parseRef.ts"
import type { Relation } from "../record/types.ts"
import type { Fields } from "../types.ts"
import { targetsOf, fieldsOf } from "../record/descriptor.ts"
import path from "node:path"
import fs from "node:fs"
import { atomicWrite } from "../lib/atomicWrite.ts"
import { serialize } from "../record/serialize.ts"
import { placementOf } from "../record/placement.ts"
import type { Store } from "./Store.ts"
import { snapshot } from "./lib/snapshot.ts"
import type { Undo } from "./types.ts"

export function rm(
  store: Store,
  collection: string,
  id: string,
  { force = false } = {}
): { id: string; inboundIgnored: number } {
  const d = store.writableDescriptor(collection)
  store.assertUnambiguous(collection, id)
  const self = `${collection}/${id}`
  const unit = store.recordRoot(d, id) // folder-shape: the whole folder goes, not just the entry file
  store._assertContained(d, unit)
  // A PARENT with records placed inside its folder is refused OUTRIGHT — `--force` included. The
  // folder delete below would erase every one of those records, each of them somebody's own
  // record with its own references, under the subject of removing one thing. There is no honest
  // force here: reassign them (or clear their owner) first, and the deletion is then an ordinary one.
  const held = store.placedChildrenIn(d, unit)
  if (held.length) {
    const lines = held.map(
      h =>
        `  ${h.count} ${h.collection} record(s) under ${h.under.subfolder}/ — dreamteamer set ${h.collection}/<id> ${h.under.parent}=<another ${collection}> (or ${h.under.parent}= to clear)`
    )
    throw new Error(
      `${self} holds records of other collections inside its folder:\n${lines.join("\n")}\nmove them first, then remove the ${collection}. nothing was removed.`
    )
  }
  // the existence check, and the FKs whose mirrors are detached below. Qualified on a COPY for the
  // same reason applyMirrorEdits qualifies `before`: a hand-edited or pre-namespace record can
  // hold `standup` where the engine writes `meetings/standup`, and a raw string compare misses it.
  const own = { ...store.read(collection, id).fields }
  store.qualifyBareRefs(d, own)
  const toArr = (v: unknown): unknown[] => (v == null ? [] : Array.isArray(v) ? v : [v])
  // `bare` is whether this field's target set has exactly one member — the only case where
  // qualifyBareRefs would have expanded an unqualified value, so the only case where an
  // unqualified value on disk can be assumed to mean this collection.
  const isSelf = (v: unknown, bare: boolean): boolean => {
    if (typeof v !== "string") return false
    const p = parseRef(v, store.namespaces)
    return p ? `${p.collection}/${p.id}` === self : bare && `${collection}/${v}` === self
  }

  // who points AT this record, and under what rule
  const setNullEdits: { rel: Relation; oid: string; file: string; of: Fields; bare: boolean }[] = []
  const restrictHits: { ref: string; field: string; file: string }[] = []
  for (const rel of store.relations()) {
    if (rel.target !== collection) continue
    const targets = targetsOf(fieldsOf(store.descriptor(rel.owner))[rel.field])
    const bare = Array.isArray(targets) && targets.length === 1
    // An owner the store cannot REWRITE cannot be set to null — and the honest fallback is
    // `restrict`, not silence: refusing is a sentence someone can act on, a skipped set-null is a
    // dangling reference from a verb that reported success.
    const clearable = rel.onDelete === "set-null" && store.canRewrite(rel.owner)
    for (const { id: oid, file, fields: of } of store.readAll(rel.owner)) {
      if (!toArr(of[rel.field]).some(v => isSelf(v, bare))) continue
      if (clearable) setNullEdits.push({ rel, oid, file, of, bare })
      else restrictHits.push({ ref: `${rel.owner}/${oid}`, field: rel.field, file: path.relative(store.root, file) })
    }
  }

  // what the text scan finds that is NOT the engine's own bookkeeping
  // The scan is per FILE, and one file can name this record TWICE — a mirror the engine wrote, and
  // a wikilink somebody typed in the same record's body. So excluding a file WHOLESALE is wrong:
  // it drops the prose reference along with the managed one, and `check` reads frontmatter and
  // never prose, so the survivor dangles in silence. A file is excluded only when the edits below
  // account for every occurrence in it.
  //
  // Paths come through `ids()` so a planned path is the exact file the mirror pass rewrites — a
  // folder-shape record's ENTRY file, not its folder — which is also the shape findInboundRefs
  // reports. A target the mirror pass would bail on (`format: binary`, runtime-based) never received
  // a mirror, so nothing is planned there and a hit in it is real.
  const planned = new Map<string, number>() // workspace-relative path -> occurrences of `self` this write removes
  const plan = (file: string, n: number): void => {
    const k = path.relative(store.root, file)
    planned.set(k, (planned.get(k) ?? 0) + n)
  }
  const memoized = new Set([collection]) // every collection whose id index this write invalidates
  for (const rel of store.relations()) {
    if (rel.owner !== collection || !store.canRewrite(rel.target)) continue
    memoized.add(rel.target)
    for (const v of toArr(own[rel.field])) {
      const p = typeof v === "string" ? parseRef(v, store.namespaces) : null
      if (!p || p.collection !== rel.target) continue // malformed, or another union member
      const f = store.mirrorFileFor(rel.target, p.id, store.repoOfFile(d, unit))
      if (f) plan(f, 1) // the one mirror entry naming this record, which the detach removes
    }
  }
  // LITERALLY, not semantically. The two numbers compared below are counted in different places —
  // this one off parsed FIELDS, `occurrences` off the file's raw BYTES — so they have to be
  // counted in the same UNIT, and the unit `occurrences` can see is "the fully-qualified string
  // `self`, present in the text". A single-target FK is legally stored BARE (`meetings: [one]` in
  // a hand-authored record: the store qualifies on write, but only through its own write path),
  // and `isSelf` matches that by design — crediting it here would claim a removal that deletes no
  // text, and the slack would swallow a real, separate wikilink in the same record: rm green, link
  // dangling, `check` silent about it because it reads frontmatter and never prose. A bare value
  // is invisible to the scan on both sides, which is the consistent answer: it contributes 0 here
  // and 0 there, and a record holding ONLY a bare FK is never named by the scan at all.
  for (const { rel, file, of } of setNullEdits) {
    memoized.add(rel.owner)
    plan(file, toArr(of[rel.field]).filter(v => v === self).length)
  }
  const occurrences = (f: string): number =>
    (fs.readFileSync(path.join(store.root, f), "utf8").match(store.refRegex(self)) ?? []).length
  const inbound = store.findInboundRefs(self).filter(f => !planned.has(f) || occurrences(f) > planned.get(f))
  // A restrict hit the scan already named is ONE reference described twice — keep the scan's
  // shape, which is what this sentence has always said. What the scan misses (a bare FK, or an
  // owner file excluded because it also holds a mirror of ours) is named as record + field.
  const extraRestrict = restrictHits.filter(h => !inbound.includes(h.file))
  if ((inbound.length || extraRestrict.length) && !force) {
    const all = [...inbound, ...extraRestrict.map(h => `${h.file} (${h.ref}.${h.field})`)]
    throw new Error(
      `${self} is referenced by:\n${all.map(f => `  ${f}`).join("\n")}\nfix the references or pass --force. nothing was removed.`
    )
  }

  // snapshot BEFORE the delete, or there is nothing left to read
  const restore = snapshot([unit])
  // ⚠ THE MEMO, on the way in AND on every way back out. `ids()` keys its cache on HEAD plus the
  // collection's TOP directory mtime, neither of which moves for a record inside an existing
  // sub-directory — so an entry populated mid-write survives a rollback, and this Store then lists
  // an id that is not on disk (or omits one that is) for the rest of the process.
  const dropMemos = () => {
    for (const c of memoized) store._idsCache.delete(c)
  }
  return store.withWriteLock(() => {
    dropMemos()
    // MIRRORS FIRST, then the owners, then the delete. The mirror pass reads its targets through
    // `ids()`, and a self-referencing relation has to still see the record it is detaching from.
    const mirrors = store.applyMirrorEdits(d, id, own, null, unit)
    const nullFiles = []
    const nullUndos: Undo[] = []
    // ONE rollback for all three mutations, used by the catch below AND handed to `commit`.
    // Order is reverse-chronological, because one file can be written twice (a mirror detach and
    // then an FK clear) and undoing the earlier write first would leave the later one standing —
    // except `restore`, which goes LAST because its snapshot of the removed record predates
    // everything, and so wins over a self-referencing edit to that same file. A COPY before
    // reversing, exactly as applyMirrorEdits does: `undo` may be called twice.
    const rollback = () => {
      for (const u of [...nullUndos].reverse()) u()
      mirrors.undo()
      restore()
      dropMemos()
    }
    try {
      for (const { rel, oid, file, bare } of setNullEdits) {
        // re-read INSIDE the lock: the mirror pass above may have just rewritten this very file
        // (two collections can point at each other), and `previous` has to be what is on disk
        // NOW or the undo below would resurrect a mirror that was correctly detached.
        const { fields: cur } = store.read(rel.owner, oid),
          od = store.descriptor(rel.owner)
        const previous = fs.readFileSync(file, "utf8")
        if (Array.isArray(cur[rel.field])) {
          cur[rel.field] = (cur[rel.field] as unknown[]).filter(v => !isSelf(v, bare))
          // the last element takes the KEY with it — `[]` is derived state leaking into a source
          if (!(cur[rel.field] as unknown[]).length) delete cur[rel.field]
        } else {
          delete cur[rel.field] // `field: null` is not a cleared reference, it is a type error
        }
        atomicWrite(file, serialize(od, cur))
        store._idsCache.delete(rel.owner)
        nullFiles.push(file)
        nullUndos.push(() => atomicWrite(file, previous))
      }
      // ⚠ THE DELETE IS INSIDE THE TRY, and it has to be. It used to be rm's FIRST mutation, so a
      // failing unlink left the tree untouched; it is now the LAST of three, and outside the
      // rollback an EACCES here (a read-only mount, `chflags uchg`, a folder-shape record raced
      // by another writer) left the record in place with a mirror already detached and an FK
      // already cleared — two stale records behind a verb that threw.
      fs.rmSync(unit, { recursive: true })
      // a placed record takes its emptied folders with it — a company's `meetings/` does not
      // outlive its last meeting; a conventional root's date folders are left as they always were
      if (placementOf(d)) store._pruneAround(d, unit)
    } catch (e) {
      rollback()
      throw e // …and now "nothing was removed" is true of everything, not just the record
    }
    // ONE commit, the record and every reference the engine moved with it: a commit where the
    // target is gone but its owners still name it is a history that never held a consistent
    // workspace.
    store.commit(
      [unit, ...mirrors.files, ...nullFiles],
      `dreamteamer: ${collection} rm ${id}`,
      rollback,
      store.repoOfFile(d, unit)
    )
    const inboundCount = inbound.length + extraRestrict.length
    return { id, inboundIgnored: force ? inboundCount : 0 }
  })
}
