import path from "node:path"
import { serializeExports } from "./serializeExports.ts"
import type { Store } from "../store/Store.ts"
import { bodyFieldOf } from "../record/descriptor.ts"
import { EXPORTS_FILE } from "../record/consts.ts"
import { exportsContext } from "../record/exportsContext.ts"
import { outsideRefs } from "../record/outsideRefs.ts"
import { readExports } from "../record/readExports.ts"
import { parseRecord } from "../record/records.ts"
import { regenerate } from "../record/regenerate.ts"
import { storageOf } from "../record/storageOf.ts"
import type { ExportChange } from "../record/types.ts"
import { exportsFacts } from "../runtime/exportsFacts.ts"
import type { Descriptor } from "../types.ts"

/** The manifest `dt exports` would write for this workspace, and what changes. */
export function planExports(store: Store): {
  dir: string
  file: string
  text: string | null
  changes: ExportChange[]
  entries: number
} {
  const facts = exportsFacts(store.root)
  const ctx = exportsContext({
    root: store.root,
    descriptors: store.descriptors,
    own: facts.own,
    dataPath: facts.data,
  })
  const readableD = (d: Descriptor | undefined): boolean => d && !storageOf(d).runtime && !storageOf(d).unavailable
  const readable = [...store.descriptors.values()].filter(readableD)
  // an unparseable record (a conflict mid-merge) is check's to report — skipped here, never fatal; while
  // one is unread, nothing it might name is dropped as unreferenced (the workspace is not read completely)
  let unparsed = false
  const fieldsAt = (d: Descriptor, file: string): Record<string, unknown> | null => {
    try {
      return parseRecord(file, d, bodyFieldOf(d))
    } catch {
      unparsed = true
      return null
    }
  }
  const held = (c: string, id: string): boolean => readableD(store.descriptors.get(c)) && store.ids(c).has(id)
  const records = readable.flatMap(d =>
    [...store.ids(d.name)]
      .filter(() => storageOf(d).format !== "binary")
      .map(([id, file]) => ({ collection: d.name, id, descriptor: d, fields: fieldsAt(d, file) }))
      .filter(r => r.fields)
  )
  const dir = store.root
  const current = readExports(dir) // throws on an unparseable file, naming it — never overwritten
  // an outside reference is one no record here holds, so nothing here resolves it
  const outside = outsideRefs({ records, held, resolve: () => null, namespaces: store.namespaces })
  const { next, changes } = regenerate({
    current: current ?? {},
    outside,
    ctx: unparsed ? { ...ctx, complete: () => false } : ctx,
    held,
  })
  return {
    dir,
    file: path.join(dir, EXPORTS_FILE),
    text: serializeExports(next),
    changes,
    entries: Object.values(next).reduce((n: number, m: object) => n + Object.keys(m).length, 0),
  }
}
