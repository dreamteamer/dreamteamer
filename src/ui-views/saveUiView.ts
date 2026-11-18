import path from "node:path"
import fs from "node:fs"
import { moduleRecord, uiViewSourceFile, workspaceSystemDir } from "../lib/schema-ops.ts"
import { IN_NODE_MODULES } from "../lib/consts.ts"
import { viewOverlayOf } from "./lib/viewOverlayOf.ts"
import type { Store } from "../store/Store.ts"
import { writeSource } from "../lib/writeSource.ts"
import { load } from "../lib/yaml.ts"
import type { Workspace } from "../types.ts"
import { kindDir } from "../compile/compile.ts"
import type { SourceDoc } from "../workspace/types.ts"
import { writeGated } from "../workspace/writeGated.ts"

/**
 * saved views (M3): a studio-saved view IS a ui-view record — but ui-views are
 * system-stored (sources + compile), so the write goes through the same gate as any
 * other schema op. the studio "save view" button lands here.
 */
export function saveUiView(
  ws: Workspace,
  store: Store,
  { id, view, moduleId }: { id: string; view: Record<string, unknown>; moduleId?: string | null }
) {
  if (!id || !/^[a-z0-9][a-z0-9-/]*$/.test(id)) throw new Error(`invalid ui-view id "${id}" — lowercase slug required`)
  // §5: `add` on a system collection takes `--module`. It used to be dropped by the parser and then
  // assigned into the VIEW as a field called `module` — `dt add ui-views … --module core` wrote
  // `module: core` into the yaml, compiled clean, and self-committed a workspace only `dt check`
  // would later object to. An explicit target module resolves the destination; without one the
  // manifest answers (an existing view is edited where it lives), and the workspace module is the
  // fallback for a new one.
  const target = moduleId ? moduleRecord(store, moduleId) : null
  if (target && IN_NODE_MODULES(target.fields.path)) {
    throw new Error(
      `module "${moduleId}" ships from node_modules (${target.fields.path}) — a write there is erased by the next npm install.\n  pick a module whose sources are in this workspace (the workspace module is the default).`
    )
  }
  const { file: dest, shipped } = target
    ? {
        file: path.join(kindDir(path.join(ws.root, target.fields.path), "ui-views"), `${id}.ui-view.yaml`),
        shipped: null,
      }
    : uiViewSourceFile(ws, id)
  // `compiled` is compile's: a view read back from the runtime carries it, and a source never does
  view = Object.fromEntries(Object.entries(view).filter(([k]) => k !== "compiled" && k !== "overlay"))
  // A view an installed package ships is never written where npm would erase it, and never refused
  // either: the save becomes an OVERLAY in the workspace module carrying only what differs from the
  // package's source, which compile merges onto it (`overlay: true`, compile.js). A changed column
  // list is a few lines, and every later fix the package ships still reaches the rest of the view.
  if (shipped && IN_NODE_MODULES(shipped)) return saveUiViewOverlay(ws, store, id, view, shipped)
  const existed = fs.existsSync(dest)
  // A module source is where this project writes down WHY a view exists; `dump` cannot keep that.
  const previous = existed ? fs.readFileSync(dest, "utf8") : null
  // ⚠ opted OUT of the comment invariant, on the same rule `rm-field` is: this write REPLACES
  // the view, so a key the caller omits is deliberately gone (see the `filter:` case) and the comment
  // explaining that key goes with it. Every key that SURVIVES keeps its comments, which is what the
  // round-trip buys and what the old `dump` could not do.
  const gate = writeGated(
    ws,
    store,
    [dest],
    `dreamteamer: ui-views ${existed ? "update" : "add"} ${id}`,
    () => {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, writeSource(previous, view))
    },
    undefined,
    { commentsMayDecrease: true }
  )
  return { id, file: dest, updated: existed, commits: gate.commits, unchanged: gate.unchanged }
}

/** The save of a package's view: the workspace module's overlay, rewritten from the package source
 *  each time (never stacked on the previous overlay), and removed when the view equals the package's. */
function saveUiViewOverlay(ws: Workspace, store: Store, id: string, view: Record<string, unknown>, shipped: string) {
  const dest = path.join(workspaceSystemDir(ws, "ui-views"), `${id}.ui-view.yaml`)
  const existed = fs.existsSync(dest)
  const delta = viewOverlayOf(load<SourceDoc | null>(fs.readFileSync(path.join(ws.root, shipped), "utf8")) ?? {}, view)
  const out = { id, file: dest, overlay: true, overlays: shipped }
  if (!Object.keys(delta).length && !existed) return { ...out, updated: false, unchanged: true }
  const previous = existed ? fs.readFileSync(dest, "utf8") : null
  const gate = writeGated(
    ws,
    store,
    [dest],
    `dreamteamer: ui-views overlay ${id}`,
    () => {
      if (!Object.keys(delta).length) return fs.rmSync(dest)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, writeSource(previous, { overlay: true, ...delta }))
    },
    undefined,
    { commentsMayDecrease: true }
  )
  return {
    ...out,
    updated: existed,
    removed: !Object.keys(delta).length || undefined,
    commits: gate.commits,
    unchanged: gate.unchanged,
  }
}
