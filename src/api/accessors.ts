// The released engine's accessors over a compiled descriptor (its `descriptor.js`), over the projection this engine
// makes of a collection (`descriptorOf`). Consumers of the engine API ask these, never the keys.
import { isObject } from "../lib/isObject.ts"
import { mapOf } from "../lib/mapOf.ts"
import { SCALARS } from "../model/SCALARS.ts"

/** a collection as the released engine compiles it: what `descriptorOf` projects, read only through here */
export type Released = Record<string, unknown> | undefined

function block(d: Released) {
  return mapOf(d?.compiled)
}
function defaults(d: Released) {
  return mapOf(block(d).defaults)
}

/** the resolved fields, the three every record has first, in form order */
function fieldsOf(d: Released): Record<string, Record<string, unknown>> {
  return Object.fromEntries(Object.entries(mapOf(block(d).fields)).map(([k, v]) => [k, mapOf(v)]))
}
/** the fields a record stores: all but the virtual ones */
function storedFieldsOf(d: Released) {
  return Object.fromEntries(Object.entries(fieldsOf(d)).filter(([, f]) => !f.virtual))
}
/** the first field `test` holds for */
function fieldWhere(d: Released, test: (f: Record<string, unknown>) => boolean) {
  return Object.entries(fieldsOf(d)).find(([, f]) => test(f))?.[0]
}
function bodyFieldOf(d: Released) {
  return fieldWhere(d, (t) => t.body === true)
}
function positionFieldOf(d: Released) {
  return fieldWhere(d, (t) => t.type === "position")
}
function requiredOf(d: Released) {
  return Object.entries(fieldsOf(d))
    .filter(([, f]) => f.required === true)
    .map(([k]) => k)
}
/** what a field references: null (not a reference), `*` (any record), or the collections it may name */
function targetsOf(f: unknown): string[] | "*" | null {
  const t = mapOf(f).type
  if (Array.isArray(t)) return t.map(String)
  if (t === "reference") return "*"
  return typeof t === "string" && !SCALARS.has(t) ? [t] : null
}
function mirrorOf(f: unknown) {
  const m = mapOf(f).mirror_of
  return typeof m === "string" ? m : undefined
}
/** an enum's values, written as a list or as a map */
function enumValues(e: unknown): unknown[] | null {
  return Array.isArray(e) ? e : isObject(e) ? Object.keys(e) : null
}
function titleOf(d: Released) {
  return d?.title ?? defaults(d).title ?? d?.name
}
function recordTitleOf(d: Released) {
  return d?.record_title ?? defaults(d).record_title ?? "{{ id }}"
}
function idsOf(d: Released) {
  return Object.assign({}, mapOf(defaults(d).ids), mapOf(d?.ids))
}

/** storage, resolved: as written over the defaults, with the facts compile decided — its own root, then each layer's */
function storageOf(d: Released) {
  const a = mapOf(d?.storage)
  const s = mapOf(defaults(d).storage)
  const path = s.path ?? a.path
  const repo = block(d).repo ?? "."
  const out: Record<string, unknown> = {
    path,
    format: a.format ?? s.format ?? "md",
    shape: a.shape ?? s.shape ?? "file",
    suffix: a.suffix ?? s.suffix,
    repo,
    runtime: block(d).runtime === true,
    external: false,
    unavailable: null,
  }
  const all = block(d).layers
  const layers = (Array.isArray(all) ? all : []).map(mapOf)
  out.layers = layers
  out.roots = [{ path, repo }, ...layers.map((t) => ({ path: t.path, repo: t.repo, layer: t.name }))]
  for (const k of ["entry", "max_bytes", "accept"]) if (a[k] !== undefined) out[k] = a[k]
  const u = mapOf(a.under)
  if (a.under)
    out.under = {
      parent: u.parent,
      subfolder: u.subfolder,
      collection: block(d).under_collection,
      id: u.id ?? "independent",
    }
  return out
}
function isRuntime(d: Released) {
  return block(d).runtime === true
}
function isInternal(d: Released) {
  return d?.internal === true
}
function isSensitive(d: Released) {
  return d?.sensitive === true
}
function isBinary(d: Released) {
  return storageOf(d).format === "binary"
}

/** the display block: as written over the defaults, sub-block by sub-block; an empty one is left out */
function displayOf(d: Released) {
  const a = mapOf(d?.display)
  const s = mapOf(defaults(d).display)
  const out: Record<string, Record<string, unknown>> = {}
  for (const b of ["nav", "list", "record", "form"]) {
    const v = Object.assign({}, mapOf(s[b]), mapOf(a[b]))
    if (Object.keys(v).length) out[b] = v
  }
  return out
}
function moduleOf(d: Released) {
  return block(d).module
}
function overlaidByOf(d: Released) {
  return block(d).overlaid_by ?? []
}
function unresolvedPeersOf(d: Released) {
  return block(d).unresolved_peers ?? []
}

/**
 * The JSON Schema the released validator runs, with only what its readers here use: each stored field, its enum
 * (on `items` for a list). Review: this engine validates without JSON Schema; nothing else is projected.
 */
function jsonSchemaOf(d: Released) {
  const properties: Record<string, unknown> = {}
  for (const [n, f] of Object.entries(storedFieldsOf(d))) {
    const values = enumValues(f.enum)
    properties[n] = !values ? {} : f.many ? { type: "array", items: { enum: values } } : { enum: values }
  }
  const res = { type: "object", properties }
  return res
}

/** every accessor, by the name the released engine's API gives it */
export const accessors = {
  fieldsOf,
  storedFieldsOf,
  bodyFieldOf,
  positionFieldOf,
  requiredOf,
  targetsOf,
  mirrorOf,
  enumValues,
  titleOf,
  recordTitleOf,
  idsOf,
  storageOf,
  isRuntime,
  isInternal,
  isSensitive,
  isBinary,
  displayOf,
  moduleOf,
  overlaidByOf,
  unresolvedPeersOf,
  jsonSchemaOf,
}
