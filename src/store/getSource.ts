import { readFileSync, statSync } from "node:fs"
import { relative } from "node:path"
import { DtError } from "../lib/DtError.ts"
import { kept } from "../lib/kept.ts"
import { titleOf } from "../lib/titleOf.ts"
import { descriptorOf } from "../model/descriptorOf.ts"
import { moduleId } from "../model/moduleId.ts"
import type { DtRecord } from "../types/DtRecord.ts"
import type { Model } from "../types/Model.ts"
import { parseText } from "./parseText.ts"

/** where a module's sources sit, by how it was delivered, in the released engine's words */
const LOCATIONS = { npm: "node_modules", workspace: "modules", engine: "node_modules" } as const

/** the fields of a source record: a collection compiled and a module projected from the model, any other kind its file */
function fieldsOf(model: Model, kind: string, id: string, file: string): Record<string, unknown> {
  if (kind === "collections") return descriptorOf(model, id)
  if (kind === "modules") {
    const m = model.modules.find((t) => moduleId(t.name) === id)
    if (!m) throw new DtError(`modules/${id}: no such record`)
    const owned = Object.values(model.collections).filter((t) => t.module === m.name || t.contributors.includes(m.name))
    return kept({
      name: m.name,
      title: m.title ?? titleOf(id),
      namespaces: m.namespaces,
      location: LOCATIONS[m.origin],
      path: relative(model.root, m.dir),
      dependencies: m.dependencies.map((t) => `modules/${moduleId(t)}`),
      peer_collections: m.peers.map((t) => `collections/${t}`),
      collections: owned.map((t) => `collections/${t.name}`).sort(),
    })
  }
  const text = readFileSync(file, "utf8").replace(/^\uFEFF/, "")
  return parseText(model.collections[kind], text, (m) => new DtError(`${kind}/${id}: unreadable — ${m.split("\n")[0]}`))
    .data
}

/** a record of a source kind (`collections/tasks`, `skills/<id>` …), read from the model and the module's own files */
export function getSource(model: Model, kind: string, id: string): DtRecord {
  const path = Object.hasOwn(model.sources[kind], id) ? model.sources[kind][id] : undefined
  if (path === undefined) throw new DtError(`${kind}/${id}: no such record`)
  const rec: DtRecord = {
    ref: `${kind}/${id}`,
    collection: kind,
    id,
    path,
    data: fieldsOf(model, kind, id, path),
    mtimeMs: statSync(path).mtimeMs,
  }
  return rec
}
