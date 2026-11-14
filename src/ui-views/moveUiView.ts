import path from "node:path"
import fs from "node:fs"
import { gatedTreeOp } from "../lib/gatedTreeOp.ts"
import { moduleRecord, uiViewSourceFile } from "../lib/schema-ops.ts"
import { IN_NODE_MODULES } from "../lib/consts.ts"
import type { Store } from "../store/Store.ts"
import type { Workspace } from "../types.ts"
import { kindDir } from "../workspace/compile.ts"
import { moduleRows } from "../workspace/moduleRows.ts"

/**
 * `dt set ui-views/<id> module=<m>` — MOVE a view's source to another module, the way `moveCollection`
 * moves a descriptor: the same bytes at the new path (a view's comments are its module's reasoning),
 * the old file gone, one compile gate, one commit per repo it touches — so a move into a linked
 * clone's module commits there, ready to publish with that module.
 */
export function moveUiView(
  ws: Workspace,
  store: Store,
  id: string,
  toModule: string,
  { dryRun = false }: { dryRun?: boolean } = {}
) {
  const { shipped } = uiViewSourceFile(ws, id)
  if (!shipped) throw new Error(`ui-view "${id}" does not exist`)
  if (IN_NODE_MODULES(shipped)) {
    throw new Error(
      `ui-view "${id}" is shipped by an installed package (${shipped}) — it moves with its package, not from here.\n  save it under a new name, then move that one.`
    )
  }
  const to = moduleRecord(store, toModule) // throws with the known-module list
  if (IN_NODE_MODULES(to.fields.path)) {
    throw new Error(
      `module "${toModule}" ships from node_modules (${to.fields.path}) — a write there is erased by the next npm install.\n  pick a module whose sources are in this workspace.`
    )
  }
  const owner = moduleRows(store)
    .filter(r => shipped.startsWith(`${r.fields.path}/`))
    .sort((a, b) => b.fields.path.length - a.fields.path.length)[0]
  const src = path.join(ws.root, shipped)
  const dest = path.join(kindDir(path.join(ws.root, to.fields.path), "ui-views"), `${id}.ui-view.yaml`)
  const plan = { id, from: owner?.id ?? null, to: toModule, file: path.relative(ws.root, dest) }
  if (path.resolve(dest) === path.resolve(src)) return { ...plan, moved: false }
  if (fs.existsSync(dest)) throw new Error(`${plan.file} already exists — move or remove it first; nothing was moved`)
  if (dryRun) return { ...plan, moved: false, dryRun: true }
  const bytes = fs.readFileSync(src)
  let moved = false
  const out = gatedTreeOp(ws, store, {
    subject: `dreamteamer: ui-views set ${id} module=${toModule}`,
    paths: [shipped, plan.file],
    mutate: () => {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, bytes)
      fs.rmSync(src)
      moved = true
    },
    undo: () => {
      if (moved && fs.existsSync(dest)) fs.rmSync(dest)
      fs.mkdirSync(path.dirname(src), { recursive: true })
      fs.writeFileSync(src, bytes)
    },
  })
  return { ...plan, moved: true, commits: out.commits }
}
