import path from "node:path"
import fs from "node:fs"
import { descriptorSources } from "./descriptorSources.ts"
import { mixinSources } from "./mixinSources.ts"
import { mixinsListedBy } from "./mixinsListedBy.ts"
import { pathOf } from "../../lib/schema-ops.ts"
import { IN_NODE_MODULES } from "../../lib/consts.ts"
import type { At, SourceEdit, SourceVisitor } from "./types.ts"
import type { Position } from "../../lib/types.ts"
import { viewSources } from "./viewSources.ts"
import type { Store } from "../../store/Store.ts"
import { load } from "../../lib/yaml.ts"
import type { Workspace } from "../../types.ts"
import type { SourceDoc } from "../../workspace/types.ts"

/**
 * Walk every source with `visit`, on copies. Returns `{ positions, edits }`: every position written
 * (`{ rel, at, fixed, why }`), and for each file that changed the rewritten document beside its
 * original text.
 *
 * `visit.own(doc, at)` runs on the collection's own sources and the mixins it lists;
 * `visit.foreign(doc, at)` on every collection source; `visit.view(doc, kind, at)` on every view and
 * binding.
 */
export function walkSources(
  ws: Workspace,
  store: Store,
  collection: string,
  visit: SourceVisitor
): { positions: Position[]; edits: Map<string, SourceEdit> } {
  const positions: Position[] = []
  const edits = new Map<string, SourceEdit>()
  const record = (file: string, doc: SourceDoc, before: string, why?: string) => {
    const rel = path.relative(ws.root, file)
    const at: { label: string; reason?: string; key?: { path: (string | number)[]; to: string } }[] = []
    // `renamedTo` marks a position that is a mapping KEY renamed in place — written to the bytes
    // first (`renameKeys`), so the comments inside the pair stay with it
    const note: At = (label, reason, renamedTo, keyPath) => {
      at.push({
        label,
        reason,
        ...(renamedTo !== undefined && { key: { path: keyPath ?? pathOf(label), to: renamedTo } }),
      })
    }
    return {
      note,
      done: () => {
        if (!at.length) return
        const blocked =
          why ?? (IN_NODE_MODULES(rel) ? "it ships from node_modules, and `npm install` would erase the write" : null)
        for (const a of at)
          positions.push({ rel, at: a.label, fixed: !blocked && !a.reason, why: a.reason ?? blocked ?? undefined })
        if (!blocked && !at.some(a => a.reason))
          edits.set(file, { before, doc, keys: at.filter(a => a.key).map(a => a.key) })
      },
    }
  }
  for (const file of descriptorSources(ws, store)) {
    const before = fs.readFileSync(file, "utf8")
    const doc = load<SourceDoc | null>(before)
    if (!doc || typeof doc !== "object") continue
    const r = record(file, doc, before)
    if (doc.name === collection) visit.own(doc, r.note)
    visit.foreign?.(doc, r.note)
    r.done()
  }
  const listed = mixinsListedBy(ws, collection)
  for (const { id, file } of mixinSources(store)) {
    const before = fs.readFileSync(file, "utf8")
    const doc = load<SourceDoc | null>(before)
    if (!doc || typeof doc !== "object") continue
    const r = record(
      file,
      doc,
      before,
      `mixin "${id}" is shared by every collection that lists it — rewrite it by hand, or move the field onto ${collection}`
    )
    if (listed.has(id)) visit.own(doc, r.note)
    visit.foreign?.(doc, r.note)
    r.done()
  }
  for (const { file, kind } of viewSources(store)) {
    const before = fs.readFileSync(file, "utf8")
    const doc = load<SourceDoc | null>(before)
    if (!doc || typeof doc !== "object") continue
    const r = record(file, doc, before)
    visit.view(doc, kind, r.note)
    r.done()
  }
  return { positions, edits }
}
