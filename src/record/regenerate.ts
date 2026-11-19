import { sees } from "./sees.ts"
import type { ExportChange, ExportEntry, ExportRefs, ExportsContext, OutsideRef } from "./types.ts"

/**
 * The manifest `dt exports` would write for `repo` in this context, and why — design §3's rules:
 * add an outside reference that resolves here; refresh a label only where the entry's holder is seen
 * and still has the id (its `from` never changes); fill a holder-less entry whose id resolves here;
 * drop an entry for an id the repo now holds, one whose seen holder lost the id, and — only where this
 * context reads every record of the repo — one nothing references; keep everything else as written.
 */
export function regenerate({
  current,
  outside,
  ctx,
  repo,
  held,
}: {
  current: ExportRefs | null
  outside: Map<string, OutsideRef>
  ctx: ExportsContext
  repo: string | null
  held: (coll: string, id: string) => boolean
}): { next: ExportRefs; changes: ExportChange[] } {
  const next: ExportRefs = {}
  const changes: ExportChange[] = []
  const put = (c: string, id: string, e: ExportEntry): void => {
    ;(next[c] ??= {})[id] = e
  }
  const complete = ctx.complete(repo)
  for (const [c, ids] of Object.entries(current ?? {})) {
    for (const [id, e] of Object.entries(ids)) {
      const ref = `${c}/${id}`
      const o = outside.get(ref)
      const why = held(c, id)
        ? "held by the repo itself"
        : !o && complete
          ? "no record references it"
          : o && !o.resolved && sees(e, c, ctx)
            ? `its holder ${e.from} no longer has it`
            : null
      if (why) {
        changes.push({ ref, kind: "drop", why })
        continue
      }
      if (o?.resolved && !e.from) {
        put(c, id, o.resolved)
        changes.push({ ref, kind: "fill", why: `held by ${o.resolved.from}` })
        continue
      }
      if (o?.resolved && o.resolved.from === e.from && sees(e, c, ctx) && o.resolved.label !== e.label) {
        put(c, id, { label: o.resolved.label, from: e.from })
        changes.push({ ref, kind: "refresh", why: `label "${e.label}" is now "${o.resolved.label}"` })
        continue
      }
      put(c, id, e)
    }
  }
  for (const [ref, o] of outside) {
    if (!o.resolved || current?.[o.collection]?.[o.id]) continue
    put(o.collection, o.id, o.resolved)
    changes.push({
      ref,
      kind: "add",
      why: `named by ${o.referrers[0]}${o.referrers.length > 1 ? ` +${o.referrers.length - 1}` : ""}`,
    })
  }
  return { next, changes }
}
