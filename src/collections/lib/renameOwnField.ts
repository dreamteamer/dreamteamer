import { renameInConstraint } from "./renameInConstraint.ts"
import { renameInDisplay } from "./renameInDisplay.ts"
import { renameInTemplate } from "./renameInTemplate.ts"
import { renameKey } from "../../lib/schema-ops.ts"
import type { At } from "./types.ts"
import type { Field } from "../../types.ts"
import type { SourceDoc } from "../../workspace/types.ts"

export function renameOwnField(doc: SourceDoc, from: string, to: string, at: At): void {
  if (doc.fields && typeof doc.fields === "object") {
    if (from in doc.fields) {
      doc.fields = renameKey(doc.fields, from, to) as Record<string, Field>
      at(`fields.${from}`, undefined, to)
    }
    for (const [k, f] of Object.entries(doc.fields as Record<string, Field>)) {
      if (f?.display?.unit_field === from) {
        f.display.unit_field = to
        at(`fields.${k}.display.unit_field`)
      }
    }
  }
  if (doc.storage?.under?.parent === from) {
    doc.storage.under.parent = to
    at("storage.under.parent")
  }
  const idsFrom = doc.ids?.from
  if (Array.isArray(idsFrom)) idsFrom.forEach((_, i) => renameInTemplate(idsFrom, i, from, to, at, `ids.from[${i}]`))
  else renameInTemplate(doc.ids, "from", from, to, at, "ids.from")
  renameInTemplate(doc, "record_title", from, to, at, "record_title")
  renameInDisplay(doc.display, from, to, at, "display")
  ;(Array.isArray(doc.constraints) ? doc.constraints : []).forEach((c, i) =>
    renameInConstraint(c, from, to, at, `constraints[${i}]`)
  )
}
