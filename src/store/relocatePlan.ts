import path from "node:path"
import { placementOf } from "../record/placement.ts"
import { symlinkBelow } from "../lib/symlinkBelow.ts"
import fs from "node:fs"
import { bodyField } from "../record/bodyField.ts"
import { parseRef } from "../record/parseRef.ts"
import { parseRecord } from "../record/records.ts"
import { ownerIdOf } from "../record/ownerIdOf.ts"
import { storageOf } from "../record/storageOf.ts"
import { idFromRecordPath } from "../record/idFromRecordPath.ts"
import type { Store } from "./Store.ts"
import type { RelocatePlan } from "./types.ts"
import { recordFileName } from "./lib/recordFileName.ts"

export function relocatePlan(
  store: Store,
  collection: string,
  only: string[] | null = null,
  { toRoot = false } = {}
): RelocatePlan<"placement" | "shape" | "to-root"> {
  const d = store.writableDescriptor(collection)
  const moves: RelocatePlan<"placement" | "shape" | "to-root">["moves"] = []
  const problems: string[] = []
  const rel = (p: string): string => path.relative(store.root, p)
  const wanted = only ? new Set(only) : null
  const plan = (id: string, from: string, to: string, why: "placement" | "shape" | "to-root"): void => {
    const link = placementOf(d) ? symlinkBelow(store.parentDir(d), to) : null
    if (link)
      problems.push(
        `${collection}/${id}: ${rel(to)} is behind the symlink ${rel(link)} — a placed record is never written through a link`
      )
    else if (fs.existsSync(to))
      problems.push(
        `${collection}/${id}: ${rel(from)} belongs at ${rel(to)}, which already exists — two files claim one id; remove one before relocating`
      )
    else moves.push({ id, from, to, why })
  }
  const under = placementOf(d)
  if (under && toRoot) {
    // the REVERSE: every record out of its parent's folder and into the collection's own root, ids
    // unchanged — what makes dropping or changing `storage.under` a safe two-step (see compile)
    for (const [id, file] of store.ids(collection)) {
      if (wanted && !wanted.has(id)) continue
      const to = path.join(store.dir(d), recordFileName(d, id))
      if (to !== file) plan(id, file, to, "to-root")
    }
  } else if (under) {
    const bf = bodyField(d)
    const parse = (v: string) => parseRef(v, store.namespaces)
    for (const [id, file] of store.ids(collection)) {
      if (wanted && !wanted.has(id)) continue
      const fields = parseRecord(file, d, bf)
      store.qualifyBareRefs(d, fields)
      // The OWNER is validated before any destination is computed (R5): a folder is never made
      // for a parent that does not exist, and a value that is not a reference to the parent
      // collection is a field to fix, not a place to move to. Either stops the whole plan.
      const raw = fields[under.parent]
      const parentId = ownerIdOf(fields, under, parse)
      if (raw != null && raw !== "" && !parentId) {
        problems.push(
          `${collection}/${id}: ${under.parent} is "${raw}", not a reference to ${under.collection} — fix the field first`
        )
        continue
      }
      if (parentId && !store.ids(under.collection).has(parentId)) {
        problems.push(
          `${collection}/${id}: ${under.parent} is ${raw} — no such record; fix the field first (dreamteamer check names it)`
        )
        continue
      }
      const to = store.filePath(d, id, undefined, fields)
      if (to !== file) plan(id, file, to, "placement")
    }
  }
  if (storageOf(d).shape === "folder" && fs.existsSync(store.dir(d))) {
    // legacy file-shape records sit at the TOP of the folder — a folder id is one segment
    const asFile = { ...d, storage: { ...d.storage, shape: "file" as const } }
    for (const name of fs.readdirSync(store.dir(d)).sort()) {
      const p = path.join(store.dir(d), name)
      if (name.startsWith(".") || fs.statSync(p).isDirectory()) continue
      const id = idFromRecordPath(asFile, name)
      if (id === null || (wanted && !wanted.has(id))) continue
      plan(id, p, path.join(store.dir(d), id, storageOf(d).entry), "shape")
    }
  }
  return { collection, moves, problems }
}
