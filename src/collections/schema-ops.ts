import fs from "node:fs"
import path from "node:path"
import { baseDescriptorSource } from "./baseDescriptorSource.ts"
import { collectionSourceFile } from "./collectionSourceFile.ts"
import type { Position, Tree } from "./types.ts"
import { INJECTED_FIELDS } from "../record/INJECTED_FIELDS.ts"
import type { Store } from "../record/Store.ts"
import { isRuntime } from "../record/descriptor.ts"
import { EXT } from "../record/records.ts"
import { storageOf } from "../record/storageOf.ts"
import { load } from "../record/yaml.ts"
import { loadDescriptors } from "../runtime/loadDescriptors.ts"
import { readManifest } from "../runtime/runtime.ts"
import type { DreamteamerBlock, PackageJson, Workspace } from "../types.ts"
import { compile, kindDir } from "../workspace/compile.ts"
import { moduleRows } from "../workspace/moduleRows.ts"
import type { ModuleRecordRow, SourceDoc } from "../workspace/types.ts"
import { FIELD_OPTIONS, TEMPLATE_OPTIONS } from "../workspace/views.ts"

/** The compile half of the gate, under the same lock, with no source write and no commit — for a
 *  schema op that turns out to ask for what is already on disk. Materializing `.dreamteamer/` is the
 *  point rather than a side effect: the caller is about to report success, and success has always
 *  meant "the compiled runtime is valid and current". */
export function compileGated(ws: Workspace, store: Store): 0 {
  return store.withWriteLock(() => compile(ws))
}

// ---- modules ---------------------------------------------------------------------------------
// A module is THREE-SPELLED today: the package `name` (discovery, `dependencies`), the
// folder (the `workspace_module` key), and the slugged scope-stripped record id. The RECORD ID is
// the identity everywhere the operator types it — `--module <id>`, `modules/<id>` references,
// `dependencies` values — and the engine maps id → package name internally. `add modules` sets all
// three to one string so a new module never forks; an existing forked module keeps working, and
// `dt list modules` prints all three columns so the fork is visible.

/** A module id: the same id-safe alphabet a namespace segment uses, because it becomes a folder
 *  name, a package name and a record id at once. */
export const MODULE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** One module, or the refusal §13 requires: `no module "nope" — known: core, hr, default (dt list
 *  modules). A module is named by its id.` */
export function moduleRecord(store: Store, id: string): ModuleRecordRow {
  const rows = moduleRows(store)
  const hit = rows.find(r => r.id === id)
  if (hit) return hit
  throw new Error(
    `no module "${id}" — known: ${rows.map(r => r.id).join(", ") || "none"} (dt list modules). A module is named by its id.`
  )
}

/** id → the package `name` its sources actually spell, which is what `dependencies` and `disable`
 *  are written in. Equal to the id for anything `add modules` created. */
export const packageNameOf = (store: Store, id: string): string | undefined => moduleRecord(store, id).fields.name

/** Read → mutate the `dreamteamer` section → write, preserving every other key and the tab
 *  indentation `init` uses. Returns the file path so a caller can put it in a pathspec. */
export function editModulePkg(file: string, mutate: (block: DreamteamerBlock, pkg: PackageJson) => void): string {
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"))
  pkg.dreamteamer ??= {}
  mutate(pkg.dreamteamer, pkg)
  fs.writeFileSync(file, JSON.stringify(pkg, null, "\t") + "\n")
  return file
}

export const nameList = (v: unknown): string[] =>
  (Array.isArray(v) ? v : String(v).split(",")).map(x => String(x).trim()).filter(Boolean)

// ---- the positions that name a field, and a value ----------------------------------------------
// A field is referenced BY NAME, not as a `<collection>/<id>` reference, so `store.rewriteRefs` can
// see none of it. Rule 6 is the list of every position a descriptor, a view or a binding may name a
// field in — compile validates each one — and these walkers visit exactly that list:
//
//   the collection's own sources (its base and every overlay):
//     `fields.<f>` · a field's `display.unit_field` · `storage.under.parent` · `ids.from` ·
//     `record_title` · `display.list.columns`/`sort`/`options` · `display.record.badge`/
//     `color_by`/`subtitle` · `display.form.sections` · every `constraints` property name
//   every other collection source:  a mirror's `mirror_of` naming the field on this collection
//   ui-views:          `filter` (one hop through a reference included) and the `display` block
//   command-bindings:  `available_when` · `done_when`
//   the records:       the frontmatter key
//
// Each walker REWRITES A COPY and records where it wrote, so a dry run, a refusal and the real run
// are one traversal and cannot disagree about what is affected. A position that cannot be rewritten
// — a source `npm install` would erase, a mixin every collection listing it shares, a filter hop
// through a union — is recorded too, and the verb refuses naming every one of them.

/** A layout option that names a field by the role it plays (§3.5.1). */
export const OPTION_FIELD_KEYS = FIELD_OPTIONS

/** A layout option that names several. */
export const OPTION_FIELD_LISTS = ["ref_fields", "value_fields"]

/** A layout option that is a template. */
export const OPTION_TEMPLATES = TEMPLATE_OPTIONS

/** A position label back to its path from the document root: `constraints[0].if.properties.status`
 *  → `['constraints', 0, 'if', 'properties', 'status']`. Labels are built from field names and
 *  operator keys, neither of which carries a `.` or a `[`. */
export const pathOf = (label: string): (string | number)[] =>
  [...label.matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map(m => (m[2] !== undefined ? Number(m[2]) : m[1]))

export const asTree = (v: unknown): Tree | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Tree) : null

export const renameKey = (obj: Tree, from: string, to: string): Tree =>
  Object.fromEntries(Object.entries(obj).map(([k, v]) => [k === from ? to : k, v]))

export function rewriteTemplateField(tpl: unknown, from: string, to: string): unknown {
  if (typeof tpl !== "string") return tpl
  return tpl.replace(
    new RegExp(`(\\{\\{\\s*)${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s*(?:\\||\\}\\}))`, "g"),
    `$1${to}$2`
  )
}

/** The filter positions of a view or a binding. */
export const FILTER_KEYS: Record<string, string[]> = {
  "ui-views": ["filter"],
  "command-bindings": ["available_when", "done_when"],
}

export const readYaml = (file: string): SourceDoc | null => {
  try {
    return load<SourceDoc | null>(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

/** The collection a view or binding is over, bare. */
export const viewCollection = (doc: SourceDoc | null): string =>
  String(doc?.collection ?? "").replace(/^collections\//, "")

/** The refusal every positional verb gives: the positions it cannot rewrite, each with why. */
export function refusePositions(what: string, positions: Position[]): void {
  const blocked = positions.filter(p => !p.fixed)
  if (!blocked.length) return
  throw new Error(
    `${what} cannot rewrite ${blocked.length} position${blocked.length === 1 ? "" : "s"} — nothing was changed:\n${blocked.map(p => `  ${p.rel}  ${p.at} — ${p.why}`).join("\n")}`
  )
}

/** Operators whose operand IS a value, rewritten exactly. */
export const VALUE_OPS = ["_eq", "_neq", "_ieq", "_nieq"]

export const LIST_OPS = ["_in", "_nin"]

/** The workspace's writable source dir for a kind (workspace_module aware). `kindDir` picks the
 *  layout that module already uses and falls back to flat, so a `collections add` never splits a
 *  half-moved module across both. */
export function workspaceSystemDir(ws: Workspace, kind: string): string {
  const wm = ws.pkg.dreamteamer?.workspace_module
  return kindDir(wm ? path.join(ws.root, "modules", wm) : ws.root, kind)
}

/** A path git will not let us rewrite usefully: `npm install` erases it. Matched on the SEGMENT, in
 *  either separator, because manifest paths carry the host's. */
export const IN_NODE_MODULES = (rel: unknown): boolean => /(^|[\\/])node_modules([\\/]|$)/.test(String(rel))

/** The module ids whose sources declare this collection, base first — for the "declared only by X"
 *  refusal, which has to name them to be actionable. */
export function declaringModules(ws: Workspace, store: Store, collection: string): string[] {
  const { base, overlays } = baseDescriptorSource(ws, collection)
  const rows = moduleRows(store)
  const idOf = (rel: string): string => rows.find(r => String(rel).startsWith(`${r.fields.path}/`))?.id ?? "?"
  return [...new Set([base, ...overlays].filter(Boolean).map(idOf))]
}

/** The source file ONE module contributes to a collection — the read half of `--module`. Exported
 *  because `dt get collections/<c> --module <m>` is the only way to see what a given module actually
 *  wrote, and the merged descriptor cannot answer it. */
export function collectionSourceFileFor(ws: Workspace, store: Store, collection: string, moduleId?: string | null) {
  return collectionSourceFile(ws, store, collection, moduleId)
}

/** Remove now-empty parents up to (not including) the data root — a moved collection leaves its
 *  namespace folder behind otherwise. */
export function pruneEmpty(dir: string, stopAt: string): void {
  while (dir !== stopAt && dir.startsWith(stopAt) && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir)
    dir = path.dirname(dir)
  }
}

/** The fields compile injects into every collection — no source declares one. */
export const INJECTED = new Set(Object.keys(INJECTED_FIELDS))

/** Deep value equality as a string, key ORDER ignored — "is this already exactly that field" must
 *  not turn on whether the keys came back in authored order or in flag order. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null)
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`
  return `{${Object.keys(v)
    .sort()
    .map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
    .join(",")}}`
}

/**
 * WHERE A UI-VIEW'S SOURCE ACTUALLY LIVES — asked of the manifest, exactly as `descriptorSourceDir`
 * asks it for a collection, and for the same reason: the guard that matters is "will `npm install`
 * erase this write", not "which module owns it".
 *
 * ⚠ This used to be `workspaceSystemDir` unconditionally, which silently meant a view could only be
 * saved if the WORKSPACE MODULE happened to ship it. Saving one shipped by any other inline module
 * wrote a SECOND file carrying the same id, and compile refuses that by name — so the whole write
 * rolled back and the surface reported `name collision on ui-view "…"` instead of saving. Measured
 * on a three-module workspace: every one of the views shipped by a module OTHER than the workspace
 * module was unsaveable, and the failure said nothing about why.
 *
 * Returns `{ file, shipped }` — where to write, and the workspace-relative source that already
 * exists (null for a new view, which lands in the workspace module as before).
 */
export function uiViewSourceFile(ws: Workspace, id: string): { file: string; shipped: string | null } {
  const src = readManifest(ws.root)?.entries?.[`ui-views/${id}.ui-view.yaml`]?.sources?.[0]
  // sources are `{path, hash}`; tolerate the pre-0.10 string form, same as compile's staleness check
  const shipped = typeof src === "string" ? src : src?.path
  if (!shipped) return { file: path.join(workspaceSystemDir(ws, "ui-views"), `${id}.ui-view.yaml`), shipped: null }
  return { file: path.join(ws.root, shipped), shipped }
}

// ---- the identity entities: skills, agents, commands, command-bindings, mixins ----------------
// §3.1's last row. These are FLAT at a module root and stay flat (decision 274) — their ids are
// single segments, and namespacing them was cut with the wave that considered it.
//
// `add` is a SCAFFOLD for skills only, and refused with the path for the rest. That asymmetry is not
// arbitrary: a skill's minimum-that-compiles is two frontmatter keys and an empty body, which a verb
// can write honestly. An agent, a command, a binding and a mixin are all PROSE or PREDICATES —
// the value is entirely in what a human writes, and a verb that scaffolds one produces a file whose
// only content is the fact that a verb made it.

/** kind → {suffix, folder} — one table, because five verbs read it and a sixth spelling of "where
 *  does a command live" is how a kind the engine stopped knowing sat in a module for two days
 *  (decision 156). */
export const ENTITY_SHAPE: Record<string, { suffix: string; folder: boolean }> = {
  skills: { suffix: "SKILL.md", folder: true },
  agents: { suffix: ".agent.md", folder: false },
  commands: { suffix: ".command.md", folder: false },
  "command-bindings": { suffix: ".command-binding.yaml", folder: false },
  mixins: { suffix: ".mixin.yaml", folder: false },
}

/** The shape of one kind — the table above, else DERIVED from the compiled descriptor, which is how
 *  a kind an extension contributes (`proofs`) gets `rm · rename · set` without this file naming it:
 *  `storage.suffix` + the format's extension, one file per id. */
export function entityShape(ws: Workspace, kind: string): { suffix: string; folder: boolean } {
  if (ENTITY_SHAPE[kind]) return ENTITY_SHAPE[kind]
  const d = loadDescriptors(ws.root).get(kind)
  const storage = storageOf(d)
  if (!isRuntime(d) || !storage.suffix) throw new Error(`"${kind}" is not an entity kind this workspace compiles`)
  return { suffix: `.${storage.suffix}${EXT[storage.format] ?? ".md"}`, folder: storage.shape === "folder" }
}

/** Refuse a write into an installed package, with `disable` as the remedy — the message every other
 *  op in this file already gives, in one place. */
export function refuseNpmEntity(kind: string, id: string, shipped: string | null): void {
  if (!shipped || !IN_NODE_MODULES(shipped)) return
  throw new Error(
    `${kind.replace(/s$/, "")} "${id}" is shipped by an installed package (${shipped}) — a write there is erased by the next \`npm install\`.\n  disable it instead: add "${kind}/${id}" to dreamteamer.disable in package.json.`
  )
}

export const ENTITY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
