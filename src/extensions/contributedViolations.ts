import { textOf } from "../lib/compareValues.ts"
import { mapOf } from "../lib/mapOf.ts"
import { messageOf } from "../lib/messageOf.ts"
import type { Workspace } from "../types/Workspace.ts"

/**
 * What every extension's `check` reports, as the released engine collects it: each item attributed to its extension,
 * a throw being one violation, and an item marked `warning: true` a warning that does not count.
 */
export async function contributedViolations(ws: Workspace) {
  const out: { file: string; msg: string; warning?: true }[] = []
  const dt: unknown = await import("../api.js")
  for (const e of ws.extensions)
    try {
      const found: unknown = await e.check?.({ root: ws.root, ws, dt })
      for (const v of (Array.isArray(found) ? found : []).map(mapOf)) {
        const msg = `${textOf(v.message)} (${e.name})`
        const file = typeof v.file === "string" ? v.file : e.name
        out.push(v.warning === true ? { file, msg, warning: true } : { file, msg })
      }
    } catch (err) {
      out.push({ file: e.name, msg: `check failed — ${messageOf(err)}` })
    }
  return out
}
