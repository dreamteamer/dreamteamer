import { normalizeTemporal } from "./normalizeTemporal.ts"
import type { SchemaProp } from "../../record/types.ts"

export function normalizeRecord<T>(schema: SchemaProp | null | undefined, fields: T): T {
  if (!schema || fields === null || typeof fields !== "object") return fields
  const rec = fields as Record<string, unknown>
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const value = rec[key]
    if (value === undefined || value === null) continue
    if (prop?.format === "date" || prop?.format === "date-time") {
      rec[key] = normalizeTemporal(value, prop.format)
    } else if (prop?.type === "object") {
      normalizeRecord(prop, value)
    } else if (prop?.type === "array" && Array.isArray(value)) {
      const items = prop.items
      if (items?.format === "date" || items?.format === "date-time") {
        rec[key] = value.map(v => normalizeTemporal(v, items.format))
      } else if (items?.type === "object") {
        for (const row of value) normalizeRecord(items, row)
      }
    }
  }
  return fields
}
