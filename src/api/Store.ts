import { join, relative } from "node:path"
import { DtError } from "../lib/DtError.ts"
import { buildModel } from "../model/buildModel.ts"
import { descriptorOf } from "../model/descriptorOf.ts"
import { add } from "../store/add.ts"
import { get } from "../store/get.ts"
import { rm } from "../store/rm.ts"
import { set } from "../store/set.ts"
import { listIds } from "../store/listIds.ts"
import { tail } from "../store/tail.ts"
import type { Model } from "../types/Model.ts"
import { accessors, type Released } from "./accessors.ts"
import { textOf } from "./compareValues.ts"
import { folded } from "./folded.ts"
import { namespacesOf } from "./namespaces.ts"

/**
 * The released engine's `Store` over this engine's model: the projected descriptors (a Map, as its readers expect),
 * and reads that answer in its shapes. The model is built once, as the released Store loads its compiled runtime
 * once; records are read from disk on every call.
 */
export class Store {
  root: string
  model: Model
  descriptors: Map<string, Released>
  namespaces: string[]
  constructor(ws: { root: string }) {
    this.root = ws.root
    this.model = buildModel(ws.root)
    const names = Object.keys(this.model.collections).sort()
    this.descriptors = new Map(names.map((t) => [t, descriptorOf(this.model, t)]))
    this.namespaces = namespacesOf(this.model)
  }

  /** the projected descriptor, or a refusal that names the collections there are */
  descriptor(collection: string): Released {
    const d = this.descriptors.get(collection)
    if (!d) throw new DtError(`unknown collection "${collection}" (known: ${[...this.descriptors.keys()].join(", ")})`)
    return d
  }

  /** where a record is read from: a source kind's in the compiled runtime, where the released engine keeps it */
  fileOf(collection: string, id: string, path: string): string {
    const c = this.model.collections[collection]
    return this.model.sources[collection] ? join(this.root, ".dreamteamer", collection, id + tail(c)) : path
  }

  /** a record's fields and file. Review: a binary record (`format: binary`) is not read, as nowhere in this engine */
  read(collection: string, id: string) {
    const descriptor = this.descriptor(collection)
    const r = get(this.model, `${collection}/${id}`)
    const res = { fields: r.data, file: this.fileOf(collection, id, r.path), descriptor }
    return res
  }

  /** every record of a collection; one that cannot be read is left out */
  *readAll(collection: string) {
    this.descriptor(collection)
    for (const id of this.ids(collection).keys()) {
      let r: ReturnType<Store["read"]>
      try {
        r = this.read(collection, id)
      } catch {
        continue
      }
      yield { id, file: r.file, fields: r.fields }
    }
  }

  /** each id and its file */
  ids(collection: string): Map<string, string> {
    this.descriptor(collection)
    const c = this.model.collections[collection]
    const ids = listIds(this.model, c.name)
    const base = join(this.root, c.storage.path)
    return new Map(ids.map((t) => [t, this.model.sources[c.name]?.[t] ?? join(base, t + tail(c))]))
  }

  /** the folders a collection's records sit in */
  recordDirs(d: Released): string[] {
    const s = accessors.storageOf(d)
    return [join(this.root, s.runtime ? ".dreamteamer" : "", String(s.path))]
  }

  /**
   * A record's `created`: its stamp, else the date in its id when ids are made from `created`. Review: the released
   * engine falls back to the first commit holding the file; this engine runs no git here.
   */
  createdOf(collection: string, id: string, fields?: Record<string, unknown>): unknown {
    const d = this.descriptor(collection)
    if (!accessors.fieldsOf(d).created) return undefined
    if (fields?.created) return fields.created
    const from = [accessors.idsOf(d).from ?? []].flat()
    const day = /(\d{4}-\d{2}-\d{2})/.exec(id)?.[1]
    return /^\{\{\s*created\b/.test(textOf(from[0])) && day ? `${day}T00:00:00Z` : undefined
  }

  /** where a record is, relative to the workspace, and the repository that holds it */
  locate(collection: string, id: string) {
    const file = this.ids(collection).get(id)
    if (!file) throw new DtError(`${collection}/${id}: no such record`)
    const res = { file: relative(this.root, this.fileOf(collection, id, file)), repo: "." }
    return res
  }

  /** write a new record: its id given, or made from its fields */
  add(collection: string, fields: Record<string, unknown>, opts: { id?: string } = {}) {
    const r = folded(() => add(this.model, collection, fields, opts.id || undefined))
    const res = { id: r.id, file: r.path }
    return res
  }

  /** change some fields of a record; null clears one */
  set(collection: string, id: string, changes: Record<string, unknown>) {
    folded(() => set(this.model, `${collection}/${id}`, changes))
    const res = { id }
    return res
  }

  /** remove a record, refused while others point at it unless forced */
  rm(collection: string, id: string, opts: { force?: boolean } = {}) {
    folded(() => rm(this.model, `${collection}/${id}`, opts.force === true))
    const res = { id, inboundIgnored: [] }
    return res
  }
}
