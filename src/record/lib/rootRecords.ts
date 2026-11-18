import fs from "node:fs"
import path from "node:path"
import { idFromRecordPath } from "../idFromRecordPath.ts"
import { isNested, placementOf } from "../placement.ts"
import type { OnLink, PlacedRecord } from "../types.ts"
import { walk } from "../../lib/walk.ts"
import type { Descriptor } from "../../types.ts"

/**
 * Every record file of `d` under ONE root, as `{ id, file, root, parentId }`. A placed root (one with
 * a `parentId`) is walked through REAL entries only — a symlinked sub-folder or file inside it is
 * skipped and reported to `onLink` (R2b); the collection's own root keeps the ordinary walk.
 */
export function* rootRecords(
  d: Descriptor,
  root: string,
  parentId: string | null = null,
  onLink: OnLink = null
): Generator<PlacedRecord> {
  if (!fs.existsSync(root)) return
  const nested = parentId !== null && isNested(placementOf(d))
  for (const f of parentId === null ? walk(root) : walkReal(root, onLink)) {
    const local = idFromRecordPath(d, path.relative(root, f))
    if (local !== null) yield { id: nested ? `${parentId}/${local}` : local, file: f, root, parentId }
  }
}

/** `walk`, lstat-ing each entry: a symlink — to a folder or a file — is not followed. */
function* walkReal(dir: string, onLink: OnLink): Generator<string> {
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue
    const p = path.join(dir, name)
    const st = fs.lstatSync(p)
    if (st.isSymbolicLink()) {
      onLink?.(p)
      continue
    }
    if (st.isDirectory()) yield* walkReal(p, onLink)
    else yield p
  }
}
