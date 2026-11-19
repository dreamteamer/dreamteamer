import { isSoft, targetsOf } from "./descriptor.ts"
import type { Field } from "../types.ts"

/** Every hard-reference field of a descriptor's fields, nested ones included: `[path, targets, soft]`. */
export function collectRefFields(
  fields: Record<string, Field>,
  prefix: string[] = []
): [path: string[], targets: "*" | string[], soft: boolean][] {
  const out: ReturnType<typeof collectRefFields> = []
  for (const [key, f] of Object.entries(fields ?? {})) {
    if (!f || typeof f !== "object") continue
    const p = [...prefix, key]
    const targets = targetsOf(f)
    if (targets) out.push([p, targets, isSoft(f)])
    if (f.type === "object" && f.fields) out.push(...collectRefFields(f.fields, p))
  }
  return out
}
