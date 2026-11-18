import type { ExportEntry, ExportRefs } from "../record/types.ts"

/**
 * The file's bytes: tab-indented, collections and ids sorted, one line per entry, nothing time- or
 * version-dependent — so an unchanged manifest regenerates byte for byte. `null` for an empty one.
 */
export function serializeExports(refs: ExportRefs): string | null {
  const colls = Object.keys(refs)
    .filter(c => Object.keys(refs[c]).length)
    .sort()
  if (!colls.length) return null
  const entry = (e: ExportEntry): string =>
    `{ "label": ${JSON.stringify(e.label)}${e.from ? `, "from": ${JSON.stringify(e.from)}` : ""} }`
  const blocks = colls.map(
    c =>
      `\t\t${JSON.stringify(c)}: {\n${Object.keys(refs[c])
        .sort()
        .map(id => `\t\t\t${JSON.stringify(id)}: ${entry(refs[c][id])}`)
        .join(",\n")}\n\t\t}`
  )
  return `{\n\t"dreamteamer_exports": 1,\n\t"references": {\n${blocks.join(",\n")}\n\t}\n}\n`
}
