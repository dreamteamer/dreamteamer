import path from "node:path"
import { exportsFacts } from "../runtime/exportsFacts.ts"
import { exportsContext } from "../record/exportsContext.ts"
import { readExports } from "../record/readExports.ts"
import { sees } from "../record/sees.ts"
import { EXPORTS_FILE } from "../record/consts.ts"
import type { Store } from "./Store.ts"

/**
 * The entry this workspace's exports manifest holds for an id —
 * `{ label, from?, manifest, seen }`, `seen` when its holder is read here (so the entry vouches for
 * nothing: the holder answers, and lacks it) — or null. The one reading `external` and `checkRefs`
 * share, so a write and `check` (src/check/check.ts) reach one verdict on identical bytes.
 */
export function vouched(
  store: Store,
  collection: string,
  id: string
): { label: string; from?: string; manifest: string; seen: boolean } | null {
  const facts = exportsFacts(store.root)
  const ctx = exportsContext({
    root: store.root,
    descriptors: store.descriptors,
    own: facts.own,
    dataPath: facts.data,
  })
  const e = readExports(store.root)?.[collection]?.[id]
  if (!e) return null
  return {
    label: e.label,
    ...(e.from ? { from: e.from } : {}),
    manifest: path.relative(store.root, path.join(store.root, EXPORTS_FILE)),
    seen: sees(e, collection, ctx),
  }
}
