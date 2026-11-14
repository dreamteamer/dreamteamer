import type { TemplatePart } from "../types.ts"

const TOKEN = /\{\{\s*([^}]+?)\s*\}\}/g

/** Split a template into literal text and tokens: `[{ text } | { field, filters: [{ name, arg }] }]`. */
export function parseTemplate(tpl: string): TemplatePart[] {
  if (typeof tpl !== "string") throw new Error("a template is a string")
  const parts: TemplatePart[] = []
  let last = 0
  for (const m of tpl.matchAll(TOKEN)) {
    if (m.index > last) parts.push({ text: tpl.slice(last, m.index) })
    const [field, ...rest] = m[1].split("|").map(x => x.trim())
    parts.push({
      field,
      filters: rest.map(f => {
        const [name, arg] = f.split(":").map(x => x.trim())
        return arg === undefined ? { name } : { name, arg }
      }),
    })
    last = m.index + m[0].length
  }
  if (last < tpl.length) parts.push({ text: tpl.slice(last) })
  return parts
}
