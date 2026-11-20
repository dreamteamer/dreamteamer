import type { Descriptor, Fields } from "../../types.ts"
import { parseRef } from "../../record/parseRef.ts"
import { storageOf } from "../../record/storageOf.ts"
import { parseRecord } from "../../record/records.ts"
import { bodyField } from "../../record/bodyField.ts"
import fs from "node:fs"
import { atomicWrite } from "../../lib/atomicWrite.ts"
import { serialize } from "../../record/serialize.ts"
import type { Store } from "../Store.ts"
import type { Undo } from "../types.ts"

export function applyMirrorEdits(
  store: Store,
  d: Descriptor,
  id: string,
  before: Fields | null,
  after: Fields | null,
  ownerFile: string | null = null
): { files: string[]; undo: Undo } {
  const self = `${d.name}/${id}`
  // ⚠ `before` comes straight off DISK while `after` has been through validate(), which qualifies
  // bare refs — so diffing them as written strings read `meeting: standup` (hand-edited, or
  // written before namespaces) as a detach of "standup", which parses as nothing and is skipped,
  // plus an attach of "meetings/standup". The old target kept its link forever and a GREEN
  // `dt set` was what created the staleness. Qualify a COPY: qualifyBareRefs mutates, and
  // `before` is the caller's live record.
  const prior = before ? { ...before } : null
  if (prior) store.qualifyBareRefs(d, prior)
  const files: string[] = []
  const undos: Undo[] = []
  // a COPY before reversing: `undo` is handed to `commit`, and an in-place reverse would make a
  // second call replay the writes forwards rather than unwind them.
  const rollback = (): void => {
    for (const u of [...undos].reverse()) u()
  }
  const toArr = (v: unknown): unknown[] => (v == null ? [] : Array.isArray(v) ? v : [v])
  // A mirror is kept between records of ONE repo. An owner in this workspace naming a target a
  // module's own repo holds would write there a link that does not exist when that repo is read on
  // its own. So the edit below skips a target in another repo, and `check` expects mirrors per repo for the same reason.
  // `ownerFile` comes from the caller, which just wrote or read it — asking the index here would
  // re-walk the collection on every write, the quadratic shape `_indexAdd` exists to prevent.
  const ownerRepo = store.repoOfFile(d, ownerFile ?? store.ids(d.name).get(id) ?? store.dir(d))
  try {
    // EVERY row whose owner is this collection, never the first match: a union FK
    // (`type: [a, b]`) decodes to one relation row PER TARGET, all sharing one owner
    // field, and each row maintains only the refs naming its own target — which is what the
    // `parsed.collection` guard in `touch` enforces. Finding one row would maintain one member
    // of the union and silently leave the others stale.
    for (const rel of store.relations()) {
      if (rel.owner !== d.name) continue
      const was = new Set(toArr(prior?.[rel.field]))
      const now = new Set(toArr(after?.[rel.field]))
      const touch = (ref: unknown, fn: (fields: Fields, targetId: string) => void): void => {
        const parsed = typeof ref === "string" ? parseRef(ref, store.namespaces) : null
        if (!parsed || parsed.collection !== rel.target) return // malformed, or another union member — not this row's business
        // TWO TARGETS THAT CANNOT HOLD A MIRROR, and compile refuses both (see stampMirror).
        // This is the belt to that brace, because getting it wrong DESTROYS bytes rather than
        // merely mis-linking. `writableDescriptor` first: a runtime-based target's records are
        // compiled from sources, and writing one means editing a build artifact under
        // `.dreamteamer/` that is gitignored and gone at the next compile — refuse, loudly.
        const td = store.writableDescriptor(rel.target)
        // A `format: binary` record's bytes ARE the record: `read` derives its fields and
        // `serialize` has no branch for it, so this line would replace an SVG with frontmatter.
        // BAIL rather than throw — an unwritten mirror is a `check` violation someone can act
        // on; overwritten bytes are simply gone.
        if (storageOf(td).format === "binary") return
        // A DETACH can name a target that is already gone: the owner outlived it (a `--force`
        // rm), and its FK is the dangling reference `check` reports. There is no mirror left
        // to edit and `read` would throw, turning someone else's stale data into a refusal of
        // this write. An attach lands here missing only when checkRefs accepted it as external
        // (an exports manifest vouches for it): nothing here holds it, so there is no mirror to write.
        // A target whose env-pointed root cannot render here is unread: no mirror either.
        if (storageOf(td).unavailable || !store.ids(rel.target).has(parsed.id)) return
        // another repo answers: no mirror there (see above) — mirrors stay per repo
        const file = store.mirrorFileFor(rel.target, parsed.id, ownerRepo)
        if (!file) return
        const fields = parseRecord(file, td, bodyField(td))
        const previous = fs.readFileSync(file, "utf8")
        fn(fields, parsed.id)
        atomicWrite(file, serialize(td, fields))
        store._idsCache.delete(rel.target) // every mutation drops the memo, exactly as the verbs do for their own collection
        files.push(file)
        undos.push(() => atomicWrite(file, previous))
      }
      for (const ref of [...was].filter(x => !now.has(x)))
        touch(ref, f => {
          // scoped to SELF: a unique mirror naming someone else belongs to that someone else,
          // and a list mirror holds every other owner's claim alongside this one.
          if (rel.unique) {
            if (f[rel.mirror] === self) delete f[rel.mirror]
          } else f[rel.mirror] = toArr(f[rel.mirror]).filter(x => x !== self)
          // the last element takes the KEY with it. `[]` and absent read the same to `check`,
          // but only absent is what the record looks like before anything ever attached to it,
          // and a file accumulating empty keys is derived state leaking into the source.
          if (Array.isArray(f[rel.mirror]) && (f[rel.mirror] as unknown[]).length === 0) delete f[rel.mirror]
        })
      for (const ref of [...now].filter(x => !was.has(x)))
        touch(ref, (f, tid) => {
          if (rel.unique) {
            // The FK is one-to-one, so the mirror is a SCALAR and physically cannot hold a
            // second claimant. Refusing here rather than overwriting is what keeps the owning
            // side the truth: the alternative silently unlinks whoever got there first.
            if (f[rel.mirror] && f[rel.mirror] !== self) {
              throw new Error(
                `${rel.field}: ${rel.target}/${tid} already has a ${rel.mirror} (${f[rel.mirror]}) — the reference is unique — nothing was written.\n  if that claim is STALE, dreamteamer relations rebuild ${rel.target} recomputes it from the owning side.`
              )
            }
            f[rel.mirror] = self
          } else {
            // Sorted, because `expectedMirrors` sorts and `check` compares against it. Deduped,
            // because `was`/`now` are compared as written STRINGS: a hand-edited bare FK is
            // qualified on its way through validate(), so an untouched link reads as a detach of
            // `standup` plus an attach of `meetings/standup` and the mirror would grow a second
            // copy of self.
            f[rel.mirror] = [...new Set([...toArr(f[rel.mirror]), self])].sort()
          }
        })
    }
  } catch (e) {
    rollback()
    throw e
  }
  return { files, undo: rollback }
}
