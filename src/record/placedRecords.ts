import path from "node:path"
import { parentFolders } from "./parentFolders.ts"
import { placementOf } from "./placement.ts"
import { rootRecords } from "./lib/rootRecords.ts"
import { symlinkBelow } from "./symlinkBelow.ts"
import type { OnLink, PlacedRecord } from "./types.ts"
import type { Descriptor } from "../types.ts"

/**
 * Every record file of a placed collection across all its roots: the fallback root first, then each
 * parent folder's child root in parent-id order. Duplicates are NOT resolved here — a caller that
 * keeps a map keeps the first and reports the rest; last-one-wins is the one answer this must never give.
 */
export function* placedRecords(
  d: Descriptor,
  fallbackDir: string,
  parentDir: string,
  onLink: OnLink = null
): Generator<PlacedRecord> {
  const under = placementOf(d)
  yield* rootRecords(d, fallbackDir, null)
  for (const [pid, folder] of parentFolders(parentDir)) {
    const root = path.join(folder, under.subfolder)
    // a child root reached through a symlink is not read: whatever it points at is not this
    // parent's folder (see symlinkBelow) — `check` names it, the store simply does not see it
    if (symlinkBelow(parentDir, root)) continue
    yield* rootRecords(d, root, pid, onLink)
  }
}
