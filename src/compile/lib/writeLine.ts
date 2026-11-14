import { fieldsOf, idsOf, requiredOf } from "../../record/descriptor.ts"
import { enumValues } from "../../record/fields.ts"
import type { Descriptor } from "../../types.ts"

/** What can REFUSE a write, in one clause — nothing else about the fields. Required fields with no
 *  default (the CLI materializes defaults, so those never refuse) — and an id-template input is one,
 *  since a missing input refuses the add; with a list of templates, only the inputs every template
 *  names — closed enums with their size, and
 *  the first `examples:` value where one is authored. A blind session's plan was correct until its
 *  first `dt add`, which the store refused on a 100-value enum and a required field the block never
 *  showed; the descriptor stays the authority, this is the line that keeps the first write from
 *  bouncing. Empty string when there is nothing that refuses. */
export function writeLine(d: Descriptor): string {
  const props = fieldsOf(d)
  const inputs = ([] as string[])
    .concat(idsOf(d).from ?? [])
    .map(t => new Set([...String(t).matchAll(/\{\{\s*([^\s|}]+)/g)].map(m => m[1])))
  const idInputs = inputs.length ? [...inputs[0]].filter(f => inputs.every(s => s.has(f))) : []
  const required = [...new Set([...requiredOf(d), ...idInputs])].filter(
    f => props[f] && !props[f].derived && !props[f].virtual && props[f].default === undefined
  )
  const enums = Object.entries(props).flatMap(([f, p]) => {
    const e = p?.enum === undefined ? null : enumValues(p.enum)
    return e?.length ? [`${f} enum(${e.length})`] : []
  })
  const egs = Object.entries(props).flatMap(([f, p]) =>
    Array.isArray(p?.examples) && p.examples.length ? [`${f}='${p.examples[0]}'`] : []
  )
  const parts = [
    ...(required.length ? [`required ${required.join(" · ")}`] : []),
    ...(enums.length ? [enums.join(" · ")] : []),
    ...(egs.length ? [`e.g. ${egs.join(", ")}`] : []),
  ]
  return parts.join("; ")
}
