import path from "node:path"
import { serializeExports } from "./serializeExports.ts"
import type { Store } from "../record/Store.ts"
import { bodyFieldOf, recordTitleOf } from "../record/descriptor.ts"
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

/** The manifest `dt exports` would write for `repo` (null: this workspace) and what changes. */
export function planExports(
  store: Store,
  repo: string | null
): { dir: string; file: string; text: string | null; changes: ExportChange[]; entries: number } {
  const facts = exportsFacts(store.root)
  const ctx = exportsContext({
    root: store.root,
    descriptors: store.descriptors,
    own: facts.own,
    layers: facts.layers,
    dataPath: facts.data,
  })
  const readableD = (d: Descriptor | undefined): boolean => d && !storageOf(d).runtime && !storageOf(d).unavailable
  const readable = [...store.descriptors.values()].filter(readableD)
  // an unparseable record (a conflict mid-merge) is check's to report — skipped here, never fatal; while
  // one is unread, nothing it might name is dropped as unreferenced (the repo is not read completely)
  let unparsed = false
  const fieldsAt = (d: Descriptor, file: string): Record<string, unknown> | null => {
    try {
      return parseRecord(file, d, bodyFieldOf(d))
    } catch {
      unparsed = true
      return null
    }
  }
  const repoOf = (c: string, id: string): string | null | undefined => {
    const d = store.descriptors.get(c)
    const f = readableD(d) ? store.ids(c).get(id) : undefined
    return f ? (store.layerOfFile(d, f)?.layer ?? null) : undefined
  }
  const titled = (d: Descriptor, id: string, file: string): string => {
    if (storageOf(d).format === "binary") return id
    const t = /\{\{\s*([A-Za-z_][\w]*)/.exec(recordTitleOf(d))?.[1]
    return String(fieldsAt(d, file)?.[t] ?? id)
  }
  const records = readable.flatMap(d =>
    [...store.ids(d.name)]
      .filter(([id]) => repoOf(d.name, id) === repo && storageOf(d).format !== "binary")
      .map(([id, file]) => ({ collection: d.name, id, descriptor: d, fields: fieldsAt(d, file) }))
      .filter(r => r.fields)
  )
  const resolve = (c: string, id: string): { label: string; from: string | null } | null =>
    repoOf(c, id) === undefined
      ? null
      : { label: titled(store.descriptors.get(c), id, store.ids(c).get(id)), from: ctx.packageOf(repoOf(c, id)) }
  const held = (c: string, id: string): boolean => repoOf(c, id) === repo
  const dir = ctx.rootOf(repo)
  const current = readExports(dir) // throws on an unparseable file, naming it — never overwritten
  const outside = outsideRefs({ records, held, resolve, namespaces: store.namespaces })
  const { next, changes } = regenerate({
    current: current ?? {},
    outside,
    ctx: unparsed ? { ...ctx, complete: () => false } : ctx,
    repo,
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
