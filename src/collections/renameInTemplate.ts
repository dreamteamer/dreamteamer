import { rewriteTemplateField } from "./schema-ops.ts"
import type { At, Tree } from "./types.ts"

export function renameInTemplate(
  holder: Tree | unknown[] | null | undefined,
  key: string | number,
  from: string,
  to: string,
  at: At,
  label: string
): void {
  const v = (holder as Record<string | number, unknown> | null | undefined)?.[key]
  if (typeof v !== "string") return
  const next = rewriteTemplateField(v, from, to)
  if (next !== v) {
    ;(holder as Record<string | number, unknown>)[key] = next
    at(label)
  }
}
