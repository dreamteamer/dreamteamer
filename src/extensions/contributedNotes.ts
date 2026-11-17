import { mapOf } from "../lib/mapOf.ts"
import { messageOf } from "../lib/messageOf.ts"
import type { Workspace } from "../types/Workspace.ts"

/**
 * What every extension's `next` says about some records of a collection, as the released engine collects it: a line
 * about an id that was not asked about, or with no text, is dropped; a throw is one line marked `error`, never a
 * failed `next`.
 */
export function contributedNotes(ws: Workspace, collection: string, ids: string[] = []) {
  const out: { id: string | null; text: string; by: string; error?: true }[] = []
  for (const e of ws.extensions)
    try {
      const said = e.next?.({ root: ws.root, ws, collection, ids: [...ids] })
      for (const n of (Array.isArray(said) ? said : []).map(mapOf))
        if (typeof n.id === "string" && ids.includes(n.id) && typeof n.text === "string" && n.text.trim())
          out.push({ id: n.id, text: n.text.trim(), by: e.name })
    } catch (err) {
      out.push({ id: null, text: `next failed — ${messageOf(err).split("\n")[0]}`, by: e.name, error: true })
    }
  return out
}
