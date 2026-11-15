import fs from "node:fs"
import path from "node:path"
import { baseDescriptorSource } from "../lib/baseDescriptorSource.ts"
import { collectionSourceFile } from "../lib/collectionSourceFile.ts"
import { editModulePkg, nameList, packageNameOf } from "../lib/schema-ops.ts"
import { IN_NODE_MODULES } from "../lib/consts.ts"
import type { Store } from "../store/Store.ts"
import { fieldsOf } from "../record/descriptor.ts"
import { writeSource } from "../lib/writeSource.ts"
import { load } from "../lib/yaml.ts"
import { engineId } from "../runtime/runtime.ts"
import type { Workspace } from "../types.ts"
import { moduleRows } from "../workspace/moduleRows.ts"
import type { SourceDoc } from "../workspace/types.ts"
import { writeGated } from "../workspace/writeGated.ts"

/**
 * The collection-level keys `dt set collections/<c>` writes, each by its v2 path, and how each
 * parses. A dotted key is a position inside a block (`display.nav.icon=pulse`). `display.nav.order`
 * stays settable and compiles, but since 0.49 it moves no row — the nav's order is nav.yaml, and
 * `dt reorder collections/<c>` is refused saying so.
 *
 * ⚠ `name` is deliberately absent, and so are `fields`, `storage` and `ids`. Renaming a
 * collection moves its descriptor, its records, their filenames and every inbound reference in one
 * commit — that is `rename collections/<old> <new>`, and offering `name=` here would be a second
 * spelling for it that does one of those five things. Fields have verbs of their own.
 */
const text = (v: unknown): string => String(v)

const bool =
  (k: string) =>
  (v: unknown): boolean => {
    if (v === true || v === "true") return true
    if (v === false || v === "false") return false
    // a privacy or visibility switch that coerces "yes" to false is the wrong kind of forgiving
    throw new Error(`${k} takes true or false — got "${v}"`)
  }

const COLLECTION_SETTABLE: Record<string, (v: unknown) => unknown> = {
  description: text,
  use_when: text,
  title: text,
  singular: text, // the word the CLI accepts beside the name; compile refuses a collision
  record_title: text,
  // `sensitive=true` withholds the WHOLE collection from every export
  sensitive: bool("sensitive"),
  // `internal=true` takes the collection out of the domain listing and onto a surface's schema
  // surface; where its records live and whether they can be written are unchanged
  internal: bool("internal"),
  "display.nav.icon": text,
  "display.nav.order": (v: unknown): number => {
    const n = Number(v)
    if (!Number.isFinite(n)) throw new Error(`display.nav.order takes a number — got "${v}"`)
    return n
  },
  "display.nav.section": text,
  "display.list.layout": text,
  "display.list.columns": nameList,
  "display.list.sort": text,
  "display.record.layout": text,
  "display.record.subtitle": text,
  "display.record.badge": text,
  "display.record.color_by": text,
}

/** A layout option, `display.list.options.<key>` or `display.record.options.<key>`: the block is open
 *  (each layout reads its own keys), so the value is read as JSON where it parses — a number, a
 *  boolean, a list — and as the string typed otherwise. */
const OPTION_KEY = /^display\.(list|record)\.options\.[a-z][a-z0-9_]*$/

const optionValue = (v: unknown): unknown => {
  if (typeof v !== "string") return v
  try {
    return JSON.parse(v)
  } catch {
    return v
  }
}

const settableOf = (k: string): ((v: unknown) => unknown) | undefined =>
  COLLECTION_SETTABLE[k] ?? (OPTION_KEY.test(k) ? optionValue : undefined)

/** "people has no field X" / "people has no fields X, Y" — the plural without a second sentence. */
const collectionMissingFields = (name: string, missing: string[]): string =>
  `${name} has no field${missing.length === 1 ? "" : "s"} ${missing.join(", ")}`

/** Set a dotted path in a plain object, creating the blocks on the way. */
function setPath(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const keys = dotted.split(".")
  let at = obj
  for (const k of keys.slice(0, -1)) {
    if (!at[k] || typeof at[k] !== "object" || Array.isArray(at[k])) at[k] = {}
    at = at[k] as Record<string, unknown>
  }
  at[keys[keys.length - 1]] = value
}

/** Delete a dotted path, and every block the deletion leaves empty — an empty `display.nav` is a
 *  statement nobody made. */
function deletePath(obj: Record<string, unknown>, dotted: string): void {
  const keys = dotted.split(".")
  const trail: Record<string, unknown>[] = [obj]
  for (const k of keys.slice(0, -1)) {
    const next = trail[trail.length - 1]?.[k]
    if (!next || typeof next !== "object") return
    trail.push(next as Record<string, unknown>)
  }
  delete trail[trail.length - 1][keys[keys.length - 1]]
  for (let i = trail.length - 1; i > 0; i--) {
    if (Object.keys(trail[i]).length) break
    delete trail[i - 1][keys[i - 1]]
  }
}

export function setCollectionScalars(
  ws: Workspace,
  store: Store,
  name: string,
  changes: Record<string, unknown>,
  { moduleId }: { moduleId?: string } = {}
) {
  const d = store.descriptor(name)
  const unknown = Object.keys(changes).filter(k => !settableOf(k))
  if (unknown.length) {
    const k = unknown[0]
    const extra =
      k === "name"
        ? ` — a collection is renamed with its records and every inbound reference in one commit: dreamteamer rename collections/${name} <new-name>`
        : ""
    throw new Error(
      `"${k}" is not a settable key of a collection${extra}. Settable: ${Object.keys(COLLECTION_SETTABLE).join(", ")}, display.list.options.<key>, display.record.options.<key>, plus module= (which MOVES it). A field is written with dreamteamer add-field/set-field ${name}.`
    )
  }
  // The columns and the sort name fields of THIS collection. compile refuses a dangling one too;
  // refusing here names the verb that declares the field instead of rolling a write back.
  const known = fieldsOf(d)
  for (const key of ["display.list.columns", "display.list.sort", "display.record.badge", "display.record.color_by"]) {
    if (!(key in changes) || changes[key] === "" || changes[key] === null) continue // a clear has nothing to validate
    const named = key === "display.list.sort" ? [String(changes[key]).replace(/^-/, "")] : nameList(changes[key])
    const missing = named.filter(f => f && !known[f])
    if (missing.length) {
      throw new Error(
        `${key}: ${collectionMissingFields(name, missing)} — declare it first (dreamteamer add-field ${name} --name ${missing[0]} --type <t>).`
      )
    }
  }
  // ⚠ NAMED, not resolved to an overlay. `collectionSourceFile` falls back to a workspace-module
  // path for a base it cannot write, which is right for `add-field` (an overlay IS the remedy) and
  // wrong here: a collection-level key belongs to the base, and an overlay that set it would
  // silently win over the owner's choice.
  const owned = baseDescriptorSource(ws, name).base
  if (owned && IN_NODE_MODULES(owned)) {
    // How the collection is DRAWN is the one collection-level thing a workspace may change about a
    // package's collection — compile already merges an overlay's `display` per sub-block — so a
    // display write becomes that overlay. Every other key belongs to the module that owns it.
    const notDisplay = Object.keys(changes).filter(k => !k.startsWith("display."))
    if (!notDisplay.length) return setCollectionDisplayOverlay(ws, store, name, changes, owned)
    throw new Error(
      `"${name}" ships from node_modules (${owned}) — a write there is erased by the next \`npm install\`, and a collection-level key (${notDisplay.join(", ")}) belongs to the module that owns it. Its display.* keys can be changed from here (they are written as an overlay in the workspace module); for the rest, add "collections/${name}" to dreamteamer.disable and declare your own instead.`
    )
  }
  const { file } = collectionSourceFile(ws, store, name, moduleId, { subject: name })
  if (!fs.existsSync(file))
    throw new Error(`${path.relative(ws.root, file)} is not on disk — run \`dreamteamer compile\` and re-run.`)
  const previousText = fs.readFileSync(file, "utf8")
  const doc = load<SourceDoc | null>(previousText)
  const changed: string[] = []
  const gate = writeGated(
    ws,
    store,
    [file],
    `dreamteamer: collections set ${name} ${Object.keys(changes).join(" ")}`,
    () => {
      for (const [k, raw] of Object.entries(changes)) {
        // An empty value REMOVES the key — `store.set`'s convention, extended to the descriptor.
        if (raw === "" || raw === null) deletePath(doc, k)
        else setPath(doc, k, settableOf(k)(raw))
        changed.push(k)
      }
      fs.writeFileSync(file, writeSource(previousText, doc))
    }
  )
  return { name, file, changed, commits: gate.commits, unchanged: gate.unchanged }
}

/**
 * A package collection's DISPLAY, changed from the workspace: the `display.*` keys that differ from the
 * package's own source, written into the workspace module's overlay of it (created, updated, or removed
 * when nothing differs any more). A cleared key falls back to the package's value — an overlay can
 * refine a block and cannot delete from it. `options` is written WHOLE when any option differs:
 * compile merges `display.<block>` one key deep, so a lone option would drop every option the package
 * sets beside it.
 */
function setCollectionDisplayOverlay(
  ws: Workspace,
  store: Store,
  name: string,
  changes: Record<string, unknown>,
  owned: string
) {
  const { file } = collectionSourceFile(ws, store, name, undefined, { subject: name })
  const base = load<SourceDoc | null>(fs.readFileSync(path.join(ws.root, owned), "utf8")) ?? {}
  const existed = fs.existsSync(file)
  const previousText = existed ? fs.readFileSync(file, "utf8") : null
  // `fields: {}` is what makes a source v2 at all (`isV2`), the same scaffold add-field writes
  const doc = existed ? load<SourceDoc | null>(previousText) : { name, overlay: true, fields: {} }
  const at = (o: unknown, dotted: string): unknown =>
    dotted
      .split(".")
      .reduce<unknown>((n, k) => (n && typeof n === "object" ? (n as Record<string, unknown>)[k] : undefined), o)
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
  const changed: string[] = []
  for (const [k, raw] of Object.entries(changes)) {
    const clear = raw === "" || raw === null
    const opt = /^(display\.[^.]+\.options)\.(.+)$/.exec(k)
    if (opt) {
      const options = structuredClone(at(doc, opt[1]) ?? at(base, opt[1]) ?? {}) as Record<string, unknown>
      if (clear) delete options[opt[2]]
      else options[opt[2]] = settableOf(k)(raw)
      if (same(options, at(base, opt[1]))) deletePath(doc, opt[1])
      else setPath(doc, opt[1], options)
    } else {
      const value = clear ? undefined : settableOf(k)(raw)
      if (clear || same(value, at(base, k))) deletePath(doc, k)
      else setPath(doc, k, value)
    }
    changed.push(k)
  }
  const empty = Object.keys(doc).every(
    k => ["name", "overlay"].includes(k) || (k === "fields" && !Object.keys(doc.fields ?? {}).length)
  )
  if (empty && !existed) return { name, file, changed, overlay: true, unchanged: true }
  // compile refuses an overlay whose module neither depends on the base's module nor lists the
  // collection in `peer_collections`. The PEER declaration is the one that fits a display overlay —
  // it applies while the package is installed and is inert once it is not — so it is written for the
  // person in the same gated write, rather than handed back as compile's remedy to type.
  const wmPkg = path.join(
    ws.pkg.dreamteamer?.workspace_module ? path.join(ws.root, "modules", ws.pkg.dreamteamer.workspace_module) : ws.root,
    "package.json"
  )
  const owner = moduleRows(store)
    .filter(r => owned.startsWith(`${r.fields.path}/`))
    .sort((a, b) => b.fields.path.length - a.fields.path.length)[0]
  const declared = JSON.parse(fs.readFileSync(wmPkg, "utf8")).dreamteamer ?? {}
  const ownerPkg = owner ? packageNameOf(store, owner.id) : null
  // the engine's own collections are every module's to overlay (compile asks nothing of those)
  const needsPeer =
    !empty &&
    ownerPkg !== engineId().replace(/@[^@]*$/, "") &&
    !(declared.peer_collections ?? []).includes(name) &&
    !(ownerPkg && (declared.dependencies ?? []).includes(ownerPkg))
  const gate = writeGated(
    ws,
    store,
    needsPeer ? [file, wmPkg] : [file],
    `dreamteamer: collections set ${name} ${Object.keys(changes).join(" ")} (overlay)`,
    () => {
      if (empty) return fs.rmSync(file)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, writeSource(previousText, doc))
      if (needsPeer)
        editModulePkg(wmPkg, dt => {
          dt.peer_collections = [...(dt.peer_collections ?? []), name]
        })
    },
    undefined,
    { commentsMayDecrease: true }
  )
  // the declaration is a write to the module's manifest, so the result names it for every surface to say
  const peer = needsPeer ? { collection: name, module: ws.pkg.dreamteamer?.workspace_module ?? ws.pkg.name } : undefined
  return {
    name,
    file,
    changed,
    overlay: true,
    removed: empty || undefined,
    peer,
    commits: gate.commits,
    unchanged: gate.unchanged,
  }
}
