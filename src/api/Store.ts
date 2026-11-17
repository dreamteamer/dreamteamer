import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs"
import { dirname, join, relative, sep } from "node:path"
import { DtError } from "../lib/DtError.ts"
import { buildModel } from "../model/buildModel.ts"
import { descriptorOf } from "../model/descriptorOf.ts"
import { add } from "../store/add.ts"
import { get } from "../store/get.ts"
import { load } from "../store/load.ts"
import { applyMirrors, mirrorEdits } from "../store/mirrorEdits.ts"
import { parseText } from "../store/parseText.ts"
import { filesOf } from "../store/filesOf.ts"
import { find } from "../store/find.ts"
import { pathFor } from "../store/pathFor.ts"
import { referrers } from "../store/referrers.ts"
import { rewrite } from "../store/rewrite.ts"
import { write } from "../store/write.ts"
import { rm } from "../store/rm.ts"
import { set } from "../store/set.ts"
import { listIds } from "../store/listIds.ts"
import { tail } from "../store/tail.ts"
import type { Model } from "../types/Model.ts"
import { accessors, type Released } from "./accessors.ts"
import { textOf } from "../lib/compareValues.ts"
import { folded } from "./folded.ts"
import { commitArg, git } from "./git.ts"
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

  /** a record's fields and file; a binary record's fields are read from its file */
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
    const src = this.model.sources[c.name]
    if (src) return new Map(listIds(this.model, c.name).map((t) => [t, src[t]]))
    return new Map([...filesOf(this.model, c)].sort(([a], [b]) => (a < b ? -1 : 1)).map(([t, f]) => [t, f[0].path]))
  }

  /** the folders a collection's records sit in: its own, its owners' for one stored under them, each layer's */
  recordDirs(d: Released): string[] {
    const s = accessors.storageOf(d)
    const c = this.model.collections[String(d?.name)]
    const owners = c?.under ? [this.model.collections[c.under.collection].storage.path] : []
    const dirs = [String(s.path), ...owners, ...(c?.layers ?? []).map((t) => t.path)]
    return dirs.map((t) => join(this.root, s.runtime ? ".dreamteamer" : "", t))
  }

  /** the record layer a file of a collection was read from, if any */
  layerOf(collection: string, file: string) {
    return this.model.collections[collection]?.layers?.find((t) => file.startsWith(join(this.root, t.path) + sep))
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
    const l = this.layerOf(collection, file)
    const res = {
      file: relative(this.root, this.fileOf(collection, id, file)),
      repo: l ? `git_modules/${l.name}` : ".",
    }
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

  /** put a record back as it was at a commit, validated as any write; unchanged when it already is */
  revert(collection: string, id: string, hash: unknown) {
    const rev = commitArg(hash)
    const { rec, c } = load(this.model, `${collection}/${id}`)
    let text: string
    try {
      text = git(this.root, [
        "show",
        "--end-of-options",
        `${rev}:./${relative(this.root, rec.path).split("\\").join("/")}`,
      ])
    } catch {
      throw new DtError(`${collection}/${id}: no content at ${rev} — nothing was reverted`)
    }
    if (readFileSync(rec.path, "utf8") === text) return { id, reverted: false }
    const data = parseText(c, text, (m) => new DtError(`${collection}/${id} at ${rev}: unreadable — ${m}`)).data
    const mirrors = mirrorEdits(this.model, c.name, id, rec.data, data)
    folded(() => write(this.model, c, id, rec.path, data, text, rec.mtimeMs))
    applyMirrors(this.model, mirrors)
    const res = { id, reverted: true, hash: rev, file: rec.path }
    return res
  }

  /** give a record another id: its file moves, its reverse fields follow, and every record naming it is rewritten */
  rename(collection: string, from: string, to: string) {
    const { rec, c } = load(this.model, `${collection}/${from}`)
    const [old, now] = [`${c.name}/${from}`, `${c.name}/${to}`]
    const l = this.layerOf(c.name, rec.path)
    if (l)
      throw new DtError(
        `${old} is held by layer ${l.name} (${l.path}) — a layer's record is renamed in its own workspace, never from here. nothing was renamed.`,
      )
    const target = pathFor(this.model, c, to, rec.data)
    if (existsSync(target) || find(this.model, c, to)) throw new DtError(`${now} already exists — nothing renamed`)
    const owners = referrers(this.model, old)
    const gone = mirrorEdits(this.model, c.name, from, rec.data, null)
    const [src, dst] = c.storage.shape === "folder" ? [dirname(rec.path), dirname(target)] : [rec.path, target]
    mkdirSync(dirname(dst), { recursive: true })
    renameSync(src, dst)
    applyMirrors(this.model, gone)
    applyMirrors(this.model, mirrorEdits(this.model, c.name, to, null, rec.data))
    const touched = owners.map((ref) => {
      const named = Object.entries(get(this.model, ref).data).filter(([, v]) => [v].flat().includes(old))
      const swap = (v: unknown) => (v === old ? now : v)
      return rewrite(
        this.model,
        ref,
        named.map(([k, v]) => [k, Array.isArray(v) ? v.map(swap) : now]),
      )
    })
    const res = {
      id: to,
      rewrites: touched.length,
      touched: touched.map((t) => relative(this.root, t)),
      skipped: [],
      ambiguous: [],
    }
    return res
  }

  /** the files of the records that point at one, relative to the workspace */
  findInboundRefs(collection: string, id: string): string[] {
    return referrers(this.model, `${collection}/${id}`).map((t) => relative(this.root, get(this.model, t).path))
  }
}
