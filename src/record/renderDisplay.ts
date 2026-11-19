import { applyFilter } from "./lib/applyFilter.ts"
import { fmtDate } from "./lib/fmtDate.ts"
import { parseTemplate } from "./parseTemplate.ts"
import { isField } from "./template.ts"

/**
 * Render a DISPLAY template against one record. A value that is a reference renders through
 * `resolve(ref)` — the target's own record title — before filters run; a missing value renders as
 * the empty string, because a label with a gap beats a label that throws.
 * @param {string} tpl
 * @param {object} record   the record's fields, with `id` among them
 * @param {(ref: string) => string | undefined} [resolve]   reference → label
 * @param {(field: string) => boolean} [isReference]
 */
export function renderDisplay(
  tpl: string,
  record: Record<string, unknown>,
  {
    resolve,
    isReference,
  }: { resolve?: (ref: string) => string | undefined; isReference?: (field: string) => boolean } = {}
): string {
  return parseTemplate(tpl)
    .map(p => {
      if (!isField(p)) return (p as { text: string }).text
      let value: unknown = record[p.field]
      if (value === undefined || value === null || value === "") return ""
      if (Array.isArray(value))
        value = value.map(v => (isReference?.(p.field) && resolve ? (resolve(v) ?? v) : v)).join(", ")
      else if (isReference?.(p.field) && resolve) value = resolve(value as string) ?? value // a reference holds a `<collection>/<id>` string
      for (const f of p.filters) value = applyFilter(f.name, f.arg, value)
      if (value instanceof Date) value = fmtDate(value, "YYYY-MM-DD")
      return String(value)
    })
    .join("")
}
