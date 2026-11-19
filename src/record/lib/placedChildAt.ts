import { idFromRecordPath } from "../idFromRecordPath.ts"
import { placementOf } from "../placement.ts"
import type { Descriptors } from "../../types.ts"

/**
 * Map a path INSIDE a folder-shape parent's directory to the placed child record it holds, if any.
 * `rest` is the path relative to the parent collection's `storage.path` (`<parentId>/<under.subfolder>/…`).
 * Shared by `events.pathToRecord` (git paths → records) and nothing else re-derives it.
 */
export function placedChildAt(
  descriptors: Descriptors,
  parentName: string,
  rest: string
): { collection: string; id: string } | null {
  const slash = rest.indexOf("/")
  if (slash < 1) return null
  const sub = rest.slice(slash + 1)
  for (const c of descriptors.values()) {
    const under = placementOf(c)
    if (under?.collection !== parentName) continue
    const pre = `${under.subfolder}/`
    if (!sub.startsWith(pre)) continue
    const id = idFromRecordPath(c, sub.slice(pre.length))
    if (id !== null) return { collection: c.name, id }
  }
  return null
}
