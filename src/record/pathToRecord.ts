import { idFromRecordPath } from "./idFromRecordPath.ts"
import { placedChildAt } from "./lib/placedChildAt.ts"
import { storageOf } from "./storageOf.ts"
import type { Descriptor, Descriptors } from "../types.ts"

/**
 * map a workspace-relative path to {collection, id} via storage.path longest-prefix
 * match + suffix/format (file shape) or entry (folder shape). non-records → null.
 */
export function pathToRecord(descriptors: Descriptors, relPath: string): { collection: string; id: string } | null {
  let best: { d: Descriptor; base: string } | null = null // the longest root
  for (const d of descriptors.values()) {
    if (storageOf(d).runtime) continue // runtime entities aren't item events
    if (storageOf(d).unavailable) continue // its path is still the template — a literal `${env:…}/` folder is nobody's record
    const base = storageOf(d).path
    if (!base || !relPath.startsWith(base + "/")) continue
    if (best && base.length <= best.base.length) continue
    best = { d, base }
  }
  if (!best) return null
  const rest = relPath.slice(best.base.length + 1)
  const d = best.d
  if (storageOf(d).shape === "folder") {
    const entry = storageOf(d).entry ?? "SKILL.md"
    // `<id>/<entry>` is the parent's own record; anything deeper may be a record of a collection
    // stored UNDER it (`<id>/meetings/2026/10/kickoff.meeting.md`), which the longest-prefix match
    // above can never see because its own storage.path is elsewhere. One place decides, so a
    // commit, an event and a surface agree on whose record a path is.
    if (rest.endsWith("/" + entry) && rest.indexOf("/") === rest.length - entry.length - 1)
      return { collection: d.name, id: rest.slice(0, -(entry.length + 1)) }
    return placedChildAt(descriptors, d.name, rest)
  }
  const id = idFromRecordPath(d, rest)
  return id === null ? null : { collection: d.name, id }
}
