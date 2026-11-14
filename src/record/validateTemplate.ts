import { parseTemplate } from "./parseTemplate.ts"
import { FILTERS, isField } from "./template.ts"
import type { TemplatePart } from "../types.ts"

const BUILTINS = ["id", "created", "last_modified"]

/**
 * Validate a template for one position. Returns a list of errors (empty when valid), each naming the
 * position, so compile can attribute it to a file.
 * @param {string} tpl
 * @param {{ position: string, fields: Iterable<string>, id?: boolean }} ctx
 *   position — what to call the place in an error (`record_title`, `display.record.subtitle`, …)
 *   fields   — the field names the record declares
 *   id       — true for `id.from`, the one position where `seq` is legal
 */
export function validateTemplate(
  tpl: string,
  { position, fields, id = false }: { position: string; fields: Iterable<string>; id?: boolean }
): string[] {
  const errors = []
  let parts: TemplatePart[]
  try {
    parts = parseTemplate(tpl)
  } catch (e) {
    return [`${position}: ${e.message}`]
  }
  const known = new Set([...fields, ...BUILTINS, ...(id ? ["seq", "now"] : [])])
  if (!parts.some(isField))
    errors.push(`${position}: "${tpl}" names no field — a template with no {{ … }} is a constant`)
  for (const p of parts) {
    if (!isField(p)) continue
    if (!known.has(p.field)) errors.push(`${position}: "{{ ${p.field} }}" is not a field of this collection`)
    for (const f of p.filters)
      if (!FILTERS.includes(f.name))
        errors.push(`${position}: unknown filter "${f.name}" — the filters are ${FILTERS.join(" · ")}`)
  }
  return errors
}
