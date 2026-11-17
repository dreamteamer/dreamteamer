import { DtError } from "../lib/DtError.ts"
import { relationsOf } from "../model/relationsOf.ts"
import type { Model } from "../types/Model.ts"
import { refsOf } from "./expectedMirrors.ts"
import { get } from "./get.ts"
import { rewrite } from "./rewrite.ts"

/** the edits, per target record, that keep reverse fields in step with one owner record going from `before` to `after` */
export type MirrorEdits = Map<string, [string, unknown][]>

/** Refuse a write to a reverse field: it is generated, and the owner's field is what to set. */
export function refuseMirrors(model: Model, collection: string, id: string, keys: string[]) {
  for (const k of keys) {
    const r = relationsOf(model).find((t) => t.target === collection && t.mirror === k)
    if (r)
      throw new DtError(
        `${k} is generated from ${r.owner}.${r.field} — set that instead: set ${r.owner}/<id> ${r.field}=${collection}/${id} — nothing was written`,
      )
  }
}

/**
 * Plan the reverse-field edits one owner write implies, before anything is written: a unique reference that another
 * record already claims is refused here. A target that does not exist, or is binary, is left alone.
 */
export function mirrorEdits(
  model: Model,
  owner: string,
  id: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): MirrorEdits {
  const self = `${owner}/${id}`
  const res: MirrorEdits = new Map()
  const values = new Map<string, unknown>()
  for (const r of relationsOf(model)) {
    if (r.owner !== owner) continue
    const was = new Set(refsOf(before?.[r.field]).filter((t) => typeof t === "string"))
    const now = new Set(refsOf(after?.[r.field]).filter((t) => typeof t === "string"))
    function touch(ref: string, attach: boolean) {
      if (!ref.startsWith(`${r.target}/`) || model.collections[r.target].storage.format === "binary") return
      const key = `${ref}\n${r.mirror}`
      if (!values.has(key)) {
        try {
          values.set(key, get(model, ref).data[r.mirror])
        } catch {
          return // no such record: an owner outliving its target, or one vouched for from elsewhere
        }
      }
      const cur = values.get(key)
      let next: unknown
      if (r.unique) {
        if (attach && cur && cur !== self)
          throw new DtError(
            `${r.field}: ${ref} already has a ${r.mirror} (${typeof cur === "string" ? cur : JSON.stringify(cur)}) — the reference is unique — nothing was written`,
          )
        next = attach ? self : cur === self ? undefined : cur
      } else {
        const rest = refsOf(cur).filter((t) => t !== self)
        const list = attach ? [...new Set([...rest, self])].sort() : rest
        next = list.length ? list : undefined
      }
      values.set(key, next)
      const edits = res.get(ref) ?? []
      res.set(ref, [...edits.filter((t) => t[0] !== r.mirror), [r.mirror, next]])
    }
    for (const t of was) if (!now.has(t)) touch(t, false)
    for (const t of now) if (!was.has(t)) touch(t, true)
  }
  return res
}

/** Write planned reverse-field edits; returns the files written. */
export function applyMirrors(model: Model, edits: MirrorEdits): string[] {
  return [...edits].map(([ref, changes]) => rewrite(model, ref, changes, false))
}
