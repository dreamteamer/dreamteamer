import type { Workspace } from "../../types.ts"

/**
 * What every extension's `next` says about the records `ids` of `collection` — the lines `dt next`
 * prints under the bound commands, and the editor draws on a row and a page. SYNCHRONOUS, like the
 * store it reads: `dt next` is a sync verb. A line about an id that was not asked about, or one with no
 * text, is dropped; a throw is ONE line attributed to the extension (`error: true`), never a failed
 * `dt next` — what a record can do next does not depend on an optional tool being healthy.
 */
export function contributedNotes(
  ws: Workspace,
  collection: string,
  ids: string[] = []
): { id: string | null; text: string; by: string; error?: true }[] {
  const out: ReturnType<typeof contributedNotes> = []
  const asked = new Set(ids)
  for (const e of (ws.extensions ?? []).filter(x => x.next)) {
    try {
      for (const n of (e.next({ root: ws.root, ws, collection, ids: [...ids] }) ?? []) as {
        id: string
        text: string
      }[]) {
        if (asked.has(n?.id) && typeof n.text === "string" && n.text.trim())
          out.push({ id: n.id, text: n.text.trim(), by: e.name })
      }
    } catch (err) {
      out.push({
        id: null,
        text: `next failed — ${String(err?.message ?? err).split("\n")[0]}`,
        by: e.name,
        error: true,
      })
    }
  }
  return out
}
