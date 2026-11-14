import { validateTemplate } from "../../record/validateTemplate.ts"
import type { AuthoredDescriptor, Field } from "../../types.ts"

/**
 * Field names a descriptor mentions outside `fields` must exist (rule 6). Templates are parsed with
 * the one grammar. Returns errors naming each position.
 */
export function nameErrors(doc: AuthoredDescriptor): string[] {
  const errors: string[] = []
  const fields = doc.fields ?? {}
  const names = Object.keys(fields)
  const has = (f: unknown): boolean =>
    f === "id" || f === "created" || f === "last_modified" || names.includes(f as string)
  const d = doc.display ?? {}
  for (const c of d.list?.columns ?? [])
    if (!has(c)) errors.push(`display.list.columns names "${c}", which is not a field`)
  if (d.list?.sort !== undefined && !has(String(d.list.sort).replace(/^-/, "")))
    errors.push(`display.list.sort names "${d.list.sort}", which is not a field`)
  for (const k of ["badge", "color_by"])
    if (d.record?.[k] !== undefined && !has(d.record[k]))
      errors.push(`display.record.${k} names "${d.record[k]}", which is not a field`)
  if (d.record?.color_by !== undefined && fields[d.record.color_by] && !fields[d.record.color_by].enum)
    errors.push(`display.record.color_by names "${d.record.color_by}", which has no enum to take colours from`)
  const sectioned = new Set()
  for (const [i, s] of (d.form?.sections ?? []).entries()) {
    if (!s?.title) errors.push(`display.form.sections[${i}] has no title`)
    if (s?.collapsed !== undefined && typeof s.collapsed !== "boolean")
      errors.push(
        `display.form.sections "${s?.title ?? i}" has collapsed: ${JSON.stringify(s.collapsed)} — it is true or false`
      )
    for (const f of s?.fields ?? []) {
      if (!has(f)) errors.push(`display.form.sections "${s?.title ?? i}" names "${f}", which is not a field`)
      else if (fields[f]?.display?.hidden?.includes("form"))
        errors.push(`display.form.sections "${s?.title ?? i}" lists "${f}", which is hidden from the form`)
      if (sectioned.has(f)) errors.push(`display.form.sections lists "${f}" twice`)
      sectioned.add(f)
    }
  }
  const parent = doc.storage?.under?.parent
  if (parent !== undefined && (!fields[parent] || fields[parent].many))
    errors.push(`storage.under.parent names "${parent}", which is not a scalar reference field of this collection`)
  // templates
  if (doc.record_title !== undefined) {
    errors.push(...validateTemplate(doc.record_title, { position: "record_title", fields: names }))
    const first = /\{\{\s*([A-Za-z_]\w*)/.exec(doc.record_title)?.[1]
    if (first && fields[first] && !["string", "markdown"].includes(fields[first].type as string))
      errors.push(
        `record_title opens with "${first}", a ${fields[first].type} field — its first token is what \`dt add <collection> "<title>"\` fills, so it must be a string field`
      )
  }
  if (d.record?.subtitle !== undefined)
    errors.push(...validateTemplate(d.record.subtitle, { position: "display.record.subtitle", fields: names }))
  const from = doc.ids?.from
  for (const t of Array.isArray(from) ? from : from === undefined ? [] : [from])
    errors.push(...validateTemplate(t, { position: "ids.from", fields: names, id: true }))
  for (const [f, v] of Object.entries<Field>(fields))
    if (v?.item_title)
      errors.push(
        ...validateTemplate(v.item_title, { position: `fields.${f}.item_title`, fields: Object.keys(v.fields ?? {}) })
      )
  return errors
}
