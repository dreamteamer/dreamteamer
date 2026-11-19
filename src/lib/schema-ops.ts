import fs from "node:fs"
import path from "node:path"
import { baseDescriptorSource } from "./baseDescriptorSource.ts"
import { collectionSourceFile } from "./collectionSourceFile.ts"
import type { Position, Tree } from "./types.ts"
import type { Store } from "../store/Store.ts"
import { isRuntime } from "../record/descriptor.ts"
import { EXT } from "../record/consts.ts"
import { storageOf } from "../record/storageOf.ts"
import { load } from "./yaml.ts"
import { loadDescriptors } from "../runtime/loadDescriptors.ts"
import { readManifest } from "../runtime/runtime.ts"
import type { DreamteamerBlock, PackageJson, Workspace } from "../types.ts"
import { compile, kindDir } from "../compile/compile.ts"
import { moduleRows } from "../workspace/moduleRows.ts"
import type { ModuleRecordRow, SourceDoc } from "../workspace/types.ts"
import { ENTITY_SHAPE, IN_NODE_MODULES } from "./consts.ts"
/**
 * The compile half of the gate, under the same lock, with no source write and no commit — for a
 * schema op that turns out to ask for what is already on disk. Materializing `.dreamteamer/` is the
 * point rather than a side effect: the caller is about to report success, and success has always
 * meant "the compiled runtime is valid and current".
 */
export function compileGated(ws: Workspace, store: Store): 0 {
  return store.withWriteLock(() => compile(ws))
}

/**
 * One module, or the refusal §13 requires: `no module "nope" — known: core, hr, default (dt list
 * modules). A module is named by its id.`
 */
export function moduleRecord(store: Store, id: string): ModuleRecordRow {
  const rows = moduleRows(store)
  const hit = rows.find(r => r.id === id)
  if (hit) return hit
  throw new Error(
    `no module "${id}" — known: ${rows.map(r => r.id).join(", ") || "none"} (dt list modules). A module is named by its id.`
  )
}

/**
 * id → the package `name` its sources actually spell, which is what `dependencies` and `disable`
 * are written in. Equal to the id for anything `add modules` created.
 */
export const packageNameOf = (store: Store, id: string): string | undefined => moduleRecord(store, id).fields.name

/**
 * Read → mutate the `dreamteamer` section → write, preserving every other key and the tab
 * indentation `init` uses. Returns the file path so a caller can put it in a pathspec.
 */
export function editModulePkg(file: string, mutate: (block: DreamteamerBlock, pkg: PackageJson) => void): string {
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"))
  pkg.dreamteamer ??= {}
  mutate(pkg.dreamteamer, pkg)
  fs.writeFileSync(file, JSON.stringify(pkg, null, "\t") + "\n")
  return file
}

export const nameList = (v: unknown): string[] =>
  (Array.isArray(v) ? v : String(v).split(",")).map(x => String(x).trim()).filter(Boolean)

/**
 * A position label back to its path from the document root: `constraints[0].if.properties.status`
 * → `['constraints', 0, 'if', 'properties', 'status']`. Labels are built from field names and
 * operator keys, neither of which carries a `.` or a `[`.
 */
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

/**
 * The workspace's writable source dir for a kind (workspace_module aware). `kindDir` picks the
 * layout that module already uses and falls back to flat, so a `collections add` never splits a
 * half-moved module across both.
 */
export function workspaceSystemDir(ws: Workspace, kind: string): string {
  const wm = ws.pkg.dreamteamer?.workspace_module
  return kindDir(wm ? path.join(ws.root, "modules", wm) : ws.root, kind)
}

/**
 * The module ids whose sources declare this collection, base first — for the "declared only by X"
 * refusal, which has to name them to be actionable.
 */
export function declaringModules(ws: Workspace, store: Store, collection: string): string[] {
  const { base, overlays } = baseDescriptorSource(ws, collection)
  const rows = moduleRows(store)
  const idOf = (rel: string): string => rows.find(r => String(rel).startsWith(`${r.fields.path}/`))?.id ?? "?"
  return [...new Set([base, ...overlays].filter(Boolean).map(idOf))]
}

/**
 * The source file ONE module contributes to a collection — the read half of `--module`. Exported
 * because `dt get collections/<c> --module <m>` is the only way to see what a given module actually
 * wrote, and the merged descriptor cannot answer it.
 */
export function collectionSourceFileFor(ws: Workspace, store: Store, collection: string, moduleId?: string | null) {
  return collectionSourceFile(ws, store, collection, moduleId)
}

/**
 * Remove now-empty parents up to (not including) the data root — a moved collection leaves its
 * namespace folder behind otherwise.
 */
export function pruneEmpty(dir: string, stopAt: string): void {
  while (dir !== stopAt && dir.startsWith(stopAt) && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir)
    dir = path.dirname(dir)
  }
}

/**
 * Deep value equality as a string, key ORDER ignored — "is this already exactly that field" must
 * not turn on whether the keys came back in authored order or in flag order.
 */
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

/**
 * The shape of one kind — the table above, else DERIVED from the compiled descriptor, which is how
 * a kind an extension contributes (`proofs`) gets `rm · rename · set` without this file naming it:
 * `storage.suffix` + the format's extension, one file per id.
 */
export function entityShape(ws: Workspace, kind: string): { suffix: string; folder: boolean } {
  if (ENTITY_SHAPE[kind]) return ENTITY_SHAPE[kind]
  const d = loadDescriptors(ws.root).get(kind)
  const storage = storageOf(d)
  if (!isRuntime(d) || !storage.suffix) throw new Error(`"${kind}" is not an entity kind this workspace compiles`)
  return { suffix: `.${storage.suffix}${EXT[storage.format] ?? ".md"}`, folder: storage.shape === "folder" }
}

/**
 * Refuse a write into an installed package, with `disable` as the remedy — the message every other
 * op in this file already gives, in one place.
 */
export function refuseNpmEntity(kind: string, id: string, shipped: string | null): void {
  if (!shipped || !IN_NODE_MODULES(shipped)) return
  throw new Error(
    `${kind.replace(/s$/, "")} "${id}" is shipped by an installed package (${shipped}) — a write there is erased by the next \`npm install\`.\n  disable it instead: add "${kind}/${id}" to dreamteamer.disable in package.json.`
  )
}
