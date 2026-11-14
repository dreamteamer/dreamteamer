import { renameInTemplate } from "./renameInTemplate.ts"
import { OPTION_FIELD_KEYS, OPTION_FIELD_LISTS, OPTION_TEMPLATES, asTree } from "./schema-ops.ts"
import type { At } from "./types.ts"

export function renameInDisplay(display: unknown, from: string, to: string, at: At, label: string): void {
  const shown = asTree(display)
  if (!shown) return
  const ren = (v: unknown): unknown => (v === from ? to : v)
  const list = asTree(shown.list)
  if (Array.isArray(list?.columns) && list.columns.includes(from)) {
    list.columns = list.columns.map(ren)
    at(`${label}.list.columns`)
  }
  if (typeof list?.sort === "string" && list.sort.replace(/^-/, "") === from) {
    list.sort = list.sort.replace(from, to)
    at(`${label}.list.sort`)
  }
  const opts = asTree(list?.options)
  if (opts) {
    for (const k of OPTION_FIELD_KEYS)
      if (opts[k] === from) {
        opts[k] = to
        at(`${label}.list.options.${k}`)
      }
    for (const k of OPTION_FIELD_LISTS) {
      const listed = opts[k]
      if (Array.isArray(listed) && listed.includes(from)) {
        opts[k] = listed.map(ren)
        at(`${label}.list.options.${k}`)
      }
    }
    for (const k of OPTION_TEMPLATES) renameInTemplate(opts, k, from, to, at, `${label}.list.options.${k}`)
  }
  const rec = asTree(shown.record)
  if (rec) {
    for (const k of ["badge", "color_by"])
      if (rec[k] === from) {
        rec[k] = to
        at(`${label}.record.${k}`)
      }
    renameInTemplate(rec, "subtitle", from, to, at, `${label}.record.subtitle`)
  }
  const sections = asTree(shown.form)?.sections
  ;(Array.isArray(sections) ? sections : []).forEach((s: unknown, i: number) => {
    const sec = asTree(s)
    if (Array.isArray(sec?.fields) && sec.fields.includes(from)) {
      sec.fields = sec.fields.map(ren)
      at(`${label}.form.sections[${i}]`)
    }
  })
}
