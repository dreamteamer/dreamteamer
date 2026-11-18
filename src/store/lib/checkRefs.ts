import type { Descriptor, Fields } from "../../types.ts"
import { fieldsOf, targetsOf, isSoft, unresolvedPeersOf } from "../../record/descriptor.ts"
import { parseRef } from "../../record/parseRef.ts"
import { storageOf } from "../../record/storageOf.ts"
import type { Store } from "../Store.ts"
import { mirrorRemedy } from "./mirrorRemedy.ts"

/** `repo` is the referring record's: the layer that holds it, null for the write root — whose exports
 *  manifest may vouch for an id no root here holds, exactly as `check` reads it. */
export function checkRefs(store: Store, d: Descriptor, fields: Fields, repo: string | null = null): void {
  for (const [key, f] of Object.entries(fieldsOf(d))) {
    const targets = targetsOf(f)
    if (!targets) continue
    const raw = fields[key]
    if (raw == null) continue
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      if (typeof value !== "string" || value.startsWith("@")) continue
      // ONE parser for the collection/id boundary, shared with `check` and the extension —
      // a namespace that meant one thing on write and another on read would be worse than
      // no namespaces at all.
      const parsed = parseRef(value, store.namespaces)
      if (!parsed)
        throw new Error(
          `${key}: reference "${value}" is not <collection>/<id> — nothing was written.${mirrorRemedy(d, [key])}`
        )
      const { collection: coll, id } = parsed
      if (targets !== "*" && !targets.includes(coll)) {
        const want = targets.length === 1 ? `collection "${targets[0]}"` : `one of: ${targets.join(", ")}`
        throw new Error(`${key}: reference "${value}" must target ${want} — nothing was written.`)
      }
      // A SOFT reference resolves if the target is present and is ignored if it is absent
      // (see ref.js). Honoured HERE as well as in `check` on purpose: the two paths reaching
      // different verdicts on identical bytes is the divergence this validator was aligned
      // with `check` to prevent in the first place.
      const soft = isSoft(f)
      if (!store.descriptors.has(coll)) {
        // A collection the owning module DECLARED as a peer and nothing installed provides is
        // the normal state of a module opened on its own. `check` excuses it via the same
        // `unresolved_peers` compile stamps onto this descriptor, and this refused it — so the
        // module could VALIDATE records it could not WRITE, and the workaround was to hand-edit
        // the file the store exists to write. Same semantics as a soft ref ("resolve if present,
        // ignore if absent"); the collection is absent, so the value passes through unresolved.
        if (unresolvedPeersOf(d).includes(coll)) continue
        if (soft) continue
        throw new Error(`${key}: reference "${value}" targets unknown collection "${coll}" — nothing was written.`)
      }
      if (soft) continue
      // a collection whose env-pointed root cannot render here is unread, not empty — `check` passes it
      if (storageOf(store.descriptors.get(coll)).unavailable) continue
      if (store.ids(coll).has(id)) continue
      // an id no root here holds, vouched for by the referring repo's exports manifest, is
      // external (cr-dt-004) — accepted, as `check` accepts it. The manifest is read only here,
      // on the way to a refusal, so a write naming a held id never pays for it.
      const v = store.vouched(coll, id, repo)
      if (v && !v.seen) continue
      throw new Error(
        `${key}: dangling reference "${value}" — no such record${v ? ` (its holder ${v.from} is read here and does not have it)` : ""}. nothing was written.${mirrorRemedy(d, [key])}`
      )
    }
  }
}
