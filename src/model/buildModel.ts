import { readFileSync } from "node:fs"
import { isAbsolute, join, normalize, posix } from "node:path"
import { parse } from "yaml"
import { asOptional } from "../lib/asOptional.ts"
import { asString } from "../lib/asString.ts"
import { asStrings } from "../lib/asStrings.ts"
import { findFiles } from "../lib/findFiles.ts"
import { isObject } from "../lib/isObject.ts"
import { messageOf } from "../lib/messageOf.ts"
import { readOr } from "../lib/readOr.ts"
import type { Collection } from "../types/Collection.ts"
import type { Descriptor } from "../types/Descriptor.ts"
import type { Field } from "../types/Field.ts"
import type { Issue } from "../types/Issue.ts"
import type { Model } from "../types/Model.ts"
import type { Module } from "../types/Module.ts"
import { discover } from "./discover.ts"
import { readDescriptor } from "./readDescriptor.ts"
import { readExports } from "./readExports.ts"
import { readField } from "./readField.ts"
import { readRule } from "./readRule.ts"
import { readSkills } from "./readSkills.ts"
import { readSources } from "./readSources.ts"
import { SCALARS } from "./SCALARS.ts"
import { singular } from "./singular.ts"
import { underOf } from "./underOf.ts"
import { SOURCE_KINDS } from "./SOURCE_KINDS.ts"

const FORMATS = new Set(["md", "yaml", "json", "binary"])
const DESCRIPTOR_KEYS = new Set([
  "name",
  "title",
  "singular",
  "description",
  "use_when",
  "storage",
  "ids",
  "fields",
  "mixins",
  "overlay",
  "display",
  "record_title",
  "internal",
  "constraints",
  "sensitive",
])

/** the top-level keys an overlay replaces on its base, as the released engine applies them; the rest are merged */
const OVERLAID = [
  "singular",
  "description",
  "use_when",
  "title",
  "record_title",
  "internal",
  "sensitive",
  "storage",
  "ids",
] as const

/** one key of an overlay over its base, when the overlay writes it: whole, never merged key by key */
function take<K extends (typeof OVERLAID)[number]>(d: Descriptor, o: Descriptor, k: K) {
  if (o.keys.includes(k)) d[k] = o[k]
}

/** the descriptors of one kind in every module; one that cannot be read is an issue */
function sources(modules: Module[], kind: string, suffix: string, issues: Issue[]) {
  const out: Descriptor[] = []
  for (const module of modules)
    for (const file of findFiles(join(module.dir, kind), suffix)) {
      let doc: unknown
      try {
        doc = parse(readFileSync(file, "utf8"))
      } catch (e) {
        issues.push({ severity: "error", where: file, message: `unreadable YAML: ${messageOf(e)}` })
        continue
      }
      out.push(readDescriptor(doc, module, file, issues))
    }
  return out
}

function bare(name: string) {
  return name.slice(name.lastIndexOf("/") + 1)
}

/** two field definitions as one: the second's keys win, and the first's keep their places */
function merge(a: unknown, b: unknown): Record<string, unknown> {
  // a descriptor's keys are open-ended, so they are copied as a whole rather than by name
  return Object.assign({}, isObject(a) ? a : {}, isObject(b) ? b : {})
}

/**
 * The display block as the released engine merges it: the descriptor's own sub-blocks (`nav`, `list` …), each
 * completed key by key from its mixins in the order they are listed; undefined when none has one.
 */
function displayOf(layers: Descriptor[]) {
  if (!layers.some((t) => t.display)) return undefined
  const out: Record<string, unknown> = {}
  for (const t of layers)
    for (const [b, v] of Object.entries(t.display ?? {}))
      out[b] = isObject(v) && (out[b] === undefined || isObject(out[b])) ? Object.assign({}, v, out[b]) : (out[b] ?? v)
  return out
}

/**
 * A collection from its descriptor and the mixins it lists: where its records live, how ids are made. A storage or
 * id key of the wrong type is an error, and reads as absent.
 */
function collectionOf(d: Descriptor, name: string, layers: Descriptor[], issues: Issue[]) {
  const mixins = layers.filter((t) => t !== d)
  const rules = [d, ...mixins].flatMap((t) => t.constraints ?? [])
  function text(v: unknown, where: string) {
    return readOr(issues, d.file, () => asOptional(v, where, asString), undefined)
  }
  // the descriptor's own storage and id rule win over its mixins', and a later mixin's over an earlier one's
  const ids = layers.findLast((t) => t.ids !== undefined)?.ids ?? {}
  const raw = layers.findLast((t) => t.storage !== undefined)?.storage ?? {}
  const from = ids.from ?? "{{ name | slug }}"
  const path = text(raw.path, "storage.path") ?? `data/${name}`
  const format = text(raw.format, "storage.format") ?? "md"
  const suffix = text(raw.suffix, "storage.suffix") ?? bare(singular(name))
  const c: Collection = {
    name,
    singular: d.singular ? name.slice(0, name.lastIndexOf("/") + 1) + d.singular : singular(name),
    module: d.module.name,
    description: d.description,
    use_when: d.use_when,
    title: d.title,
    record_title: d.record_title,
    internal: d.internal,
    sensitive: d.sensitive,
    display: displayOf([d, ...mixins]),
    constraints: rules.length ? rules : undefined,
    // the storage keys this engine does not act on are carried as written, in their places
    storage: Object.assign({ path, format, suffix }, raw, {
      path,
      format,
      suffix,
      shape: text(raw.shape, "storage.shape"),
      entry: text(raw.entry, "storage.entry"),
    }),
    ids: {
      from: readOr(
        issues,
        d.file,
        () => (Array.isArray(from) ? asStrings(from, "ids.from") : [asString(from, "ids.from")]),
        ["{{ name | slug }}"],
      ),
      pattern: text(ids.pattern, "ids.pattern"),
    },
    fields: {},
    rules: [],
    contributors: [],
  }
  return c
}

/** the types a field names that are neither a scalar nor `known`, its nested fields' and its map values' included */
function unknownTypes(f: Field, known: (t: string) => boolean): string[] {
  const own = typeof f.type === "string" && SCALARS.has(f.type) ? [] : [f.type].flat().filter((t) => !known(t))
  const inner = [...Object.values(f.fields ?? {}), ...(f.values ? [f.values] : [])]
  return [...own, ...inner.flatMap((t) => unknownTypes(t, known))]
}

/**
 * A collection whose folder is inside another's, as an error: the outer one would read, list and delete the inner
 * one's records as its own. The released compile refuses the same pair; one folder shared by two collections is
 * allowed there and here, and the source kinds, whose records are the modules' files, are compared only with each
 * other.
 */
function overlaps(collections: Record<string, Collection>) {
  const all = Object.values(collections).map((t) => ({
    name: t.name,
    path: posix.normalize(t.storage.path).replace(/\/$/, ""),
    source: SOURCE_KINDS.includes(t.name),
  }))
  const out: Issue[] = []
  for (const o of all)
    for (const i of all)
      if (o.source === i.source && i.path.startsWith(o.path + "/"))
        out.push({
          severity: "error",
          where: i.name,
          message: `its records are stored under ${i.path}, inside the folder of ${o.name} (${o.path}), which would read them as its own — give one of them a folder of its own`,
        })
  return out
}

/** Aggregate every module's collections, mixins and overlays into one resolved workspace model. */
export function buildModel(root: string): Model {
  const { modules, issues, layers } = discover(root)
  const peers = [...new Set(modules.flatMap((t) => t.peers))]
  const mixins = new Map<string, Descriptor>()
  for (const t of sources(modules, "mixins", ".mixin.yaml", issues)) if (t.name !== undefined) mixins.set(t.name, t)

  const all = sources(modules, "collections", ".collection.yaml", issues)
  const collections: Record<string, Collection> = {}
  // each collection's fields as written, until overlays are merged and types are checked
  const raws = new Map<string, Record<string, unknown>>()
  // the descriptor that declares each collection: its file as a record of `collections`
  const files = new Map<string, string>()
  for (const d of all.filter((t) => !t.overlay)) {
    const name = d.name
    if (!name) {
      issues.push({ severity: "error", where: d.file, message: "collection has no name" })
      continue
    }
    if (collections[name]) {
      const message = `collection ${name} is already declared by ${collections[name].module}`
      issues.push({ severity: "error", where: d.file, message })
      continue
    }
    const unknown = d.keys.filter((t) => !DESCRIPTOR_KEYS.has(t))
    if (unknown.length)
      issues.push({
        severity: "warning",
        where: name,
        message: `unknown descriptor key(s) ${unknown.join(", ")} — ignored`,
      })
    const layers: Descriptor[] = []
    for (const mx of d.mixins) {
      const m = mixins.get(mx)
      if (m) layers.push(m)
      else issues.push({ severity: "error", where: name, message: `unknown mixin ${mx}` })
    }
    // an overlay's own keys (storage above all) sit above the descriptor and its mixins, a later overlay's last
    for (const o of all) if (o.overlay && o.name === name) for (const k of OVERLAID) take(d, o, k)
    layers.push(d)
    const c = collectionOf(d, name, layers, issues)
    const { path, format } = c.storage
    if (isAbsolute(path) || normalize(path).startsWith(".."))
      issues.push({
        severity: "warning",
        where: name,
        message: `its storage path, ${path}, is outside the workspace — this engine neither reads nor writes its records`,
      })
    if (!FORMATS.has(format))
      issues.push({
        severity: "error",
        where: name,
        message: `unknown storage format "${format}" — md, yaml, json or binary`,
      })
    collections[name] = c
    files.set(name, d.file)
    const fields: Record<string, unknown> = {}
    for (const t of layers) Object.assign(fields, t.fields)
    // a binary record is its file, and its fields are read from it, in the released compile's words
    if (format === "binary") {
      const desc = (t: string) => `The file's ${t}. Read from the file.`
      fields.ext ??= { type: "string", virtual: true, description: desc("extension, lowercase and without the dot") }
      fields.bytes ??= { type: "integer", virtual: true, description: desc("size in bytes") }
    }
    raws.set(name, fields)
  }
  for (const d of all.filter((t) => t.overlay)) {
    // an overlay of an absent optional peer is silent by contract
    const fields = d.name === undefined ? undefined : raws.get(d.name)
    if (!d.name || !fields) continue
    for (const [name, field] of Object.entries(d.fields)) {
      if (fields[name])
        issues.push({
          severity: "warning",
          where: `${d.name}.${name}`,
          message: `overlay from ${d.module.name} redefines an existing field`,
        })
      fields[name] = merge(fields[name], field)
    }
    const base = collections[d.name]
    if (!base.contributors.includes(d.module.name)) base.contributors.push(d.module.name)
    // an overlay's display wins key by key and its rules are added; its other keys were applied with the base's
    for (const [b, v] of Object.entries(d.display ?? {})) {
      const was = base.display?.[b]
      base.display ??= {}
      base.display[b] = isObject(v) ? Object.assign({}, isObject(was) ? was : {}, v) : v
    }
    if (d.constraints) base.constraints = [...(base.constraints ?? []), ...d.constraints]
  }
  // a field's type is a scalar, an installed collection, or a collection some module declares as an optional
  // peer. A peer that is absent keeps its field: a value there is unresolvable, not wrong. Anything else is a typo.
  for (const c of Object.values(collections))
    for (const [name, raw] of Object.entries(raws.get(c.name) ?? {})) {
      const where = `${c.name}.${name}`
      let f
      try {
        f = readField(raw)
      } catch (e) {
        issues.push({ severity: "error", where, message: messageOf(e) })
        continue
      }
      if (!f) {
        issues.push({ severity: "error", where, message: "field has no type" })
        continue
      }
      const bad = unknownTypes(f, (t) => Boolean(collections[t]) || peers.includes(t))
      if (bad.length) {
        const message = `unknown type "${bad.join(", ")}" — a type is one of ${[...SCALARS].join(" ")}, an installed collection, or a collection a module lists under peer_collections`
        issues.push({ severity: "error", where, message })
        continue
      }
      c.fields[name] = f
    }
  // a record layer lends each collection it lists, or every one when it lists none, except those whose records are
  // not a clone's: the source kinds, a module's own list, records under their owners, a folder per machine
  for (const l of layers)
    for (const c of Object.values(collections)) {
      const p = c.storage.path
      if (l.records && !l.records.includes(c.name)) continue
      if (SOURCE_KINDS.includes(c.name) || c.storage.owner === "module" || c.storage.under || p.includes("${")) {
        const message = `git_modules.${l.name}.records names ${c.name}, whose records are not a clone's to lend`
        if (l.records) issues.push({ severity: "error", where: "package.json", message })
        continue
      }
      const path = `git_modules/${l.name}/${p === `data/${c.name}` ? `${l.data}/${c.name}` : p}`
      ;(c.layers ??= []).push({ name: l.name, path })
    }
  for (const c of Object.values(collections))
    if (c.storage.under !== undefined) c.under = readOr(issues, c.name, () => underOf(c, collections), undefined)
  issues.push(...overlaps(collections))
  for (const c of Object.values(collections))
    c.rules = (c.constraints ?? []).flatMap((t, i) =>
      readOr(issues, c.name, () => [readRule(t, `constraints[${i}]`)], []),
    )
  const model: Model = {
    root,
    modules,
    collections,
    skills: readSkills(modules),
    peers,
    sources: readSources(modules, collections, files),
    exports: readExports(root, issues),
    issues,
  }
  return model
}
