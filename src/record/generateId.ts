import { applyFilter } from "./applyFilter.ts"
import { fmtDate } from "./fmtDate.ts"
import type { OnFallback } from "./types.ts"

const SEQ = "__DT_SEQ__"

export function generateId(
  tpl: string | string[],
  fields: Record<string, unknown>,
  existingIds: Iterable<string> = [],
  opts: { onFallback?: OnFallback } = {}
): string {
  // ⚠ AN ORDERED LIST IS "USE THIS, ELSE THAT" — the only way a descriptor can express a readable
  // latin handle WITHOUT forcing a required field onto every record. `id.generate` takes a string
  // or a list of them, and the FIRST template whose fields are all present wins; a template that
  // names a missing field is skipped, not fatal, until the last one, whose error is the one the
  // writer sees. Before this, a missing field threw before any fallback could run and an unknown
  // `default` filter threw too, so `{{ code }} else {{ name | slug }}` was inexpressible and the
  // only workaround was passing --id on every single add.
  if (Array.isArray(tpl)) {
    for (let i = 0; i < tpl.length; i++) {
      try {
        return generateId(tpl[i], fields, existingIds, opts)
      } catch (e) {
        if (i === tpl.length - 1) throw e
      }
    }
    throw new Error("id template list is empty — give at least one template (or pass an explicit id)")
  }
  const created = new Date()
  let sawSeq = false
  let seqPad = 0

  const rendered = tpl.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_: string, expr: string) => {
    const [head, ...filters] = expr.split("|").map(s => s.trim())
    let value: unknown
    // `created` is a stored field the engine stamps at add (descriptor v2), so an id reads it from the
    // record when it is there; with no stamp yet (a dry render) it is now.
    if (head === "created") value = fields.created ?? created
    else if (head === "now") value = created
    else if (head === "seq") {
      sawSeq = true
      value = SEQ
    } else value = fields[head]
    if (value === undefined || value === null || value === "") {
      throw new Error(`id template needs "${head}" — provide it (or pass an explicit id)`)
    }
    for (const f of filters) {
      const [name, arg] = f.split(":").map(s => s.trim())
      if (value === SEQ) {
        if (name === "pad") seqPad = Number(arg) || 0
        continue // filters never transform the seq placeholder itself
      }
      value = applyFilter(name, arg, value, { field: head, onFallback: opts.onFallback })
    }
    if (value instanceof Date) value = fmtDate(value, "YYYY-MM-DD")
    return String(value)
  })

  if (!sawSeq) return rendered

  // seq: next free number among existing ids matching the rendered prefix/suffix
  const [prefix, suffix] = rendered.split(SEQ)
  let max = 0
  for (const id of existingIds) {
    if (!id.startsWith(prefix) || !id.endsWith(suffix)) continue
    const mid = id.slice(prefix.length, suffix.length ? -suffix.length : undefined)
    if (/^\d+$/.test(mid)) max = Math.max(max, Number(mid))
  }
  const n = String(max + 1)
  return prefix + (seqPad ? n.padStart(seqPad, "0") : n) + suffix
}
