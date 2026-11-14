import path from "node:path"
import fs from "node:fs"
import { editWorkspacePkg } from "./editWorkspacePkg.ts"
import { gatedTreeOp } from "./gatedTreeOp.ts"
import { editModulePkg, moduleRecord } from "./schema-ops.ts"
import { MODULE_ID } from "./consts.ts"
import type { Store } from "../record/Store.ts"
import type { Workspace } from "../types.ts"
import { moduleRows } from "../workspace/moduleRows.ts"

export function renameModule(ws: Workspace, store: Store, oldId: string, newId: string | true | undefined) {
  if (!newId || newId === true) throw new Error("missing new module id — dreamteamer rename modules/<old> <new>")
  if (oldId === newId) return { renamed: false, id: newId, files: [] as string[], rewrites: 0 }
  if (!MODULE_ID.test(newId))
    throw new Error(`invalid module id "${newId}" — lowercase alphanumeric with single hyphens.`)
  const { fields } = moduleRecord(store, oldId)
  if (moduleRows(store).some(r => r.id === newId)) throw new Error(`module "${newId}" already exists — dt list modules`)
  if (fields.location === "node_modules") {
    throw new Error(
      `module "${oldId}" ships from node_modules (${fields.path}) — a write there is erased by the next \`npm install\`. Rename it in its own repo and release.`
    )
  }
  if (fields.location === "git_modules") {
    // ⚠ TWO COMMITS BY CONSTRUCTION, and the verb says so rather than half-doing it: the module's
    // package.json lives in the clone's own repo, and this workspace's half (git_modules,
    // dependencies, modules/<id> refs) is a commit here. Perform the workspace half only after the
    // clone half has landed and been pushed.
    throw new Error(
      `module "${oldId}" is a clone under ${fields.path}, whose package.json is in ANOTHER repo — a git-shape rename is TWO commits by construction.\n  1. rename it there (package.json name → "${newId}") and push;\n  2. re-run this to perform the workspace half: dreamteamer.git_modules, every dependencies entry, and modules/${oldId} references.`
    )
  }
  const oldPkgName = fields.name
  const oldRoot = path.join(ws.root, "modules", oldId)
  const newRoot = path.join(ws.root, "modules", newId)
  if (fs.existsSync(newRoot)) throw new Error(`modules/${newId} already exists on disk`)

  const snapshots = new Map() // absolute file -> bytes, for undo
  const snap = (f: string): string => {
    if (!snapshots.has(f) && fs.existsSync(f)) snapshots.set(f, fs.readFileSync(f))
    return f
  }
  const paths = new Set([`modules/${oldId}`, `modules/${newId}`, "package.json"])
  let moved = false
  let rewrites = 0
  const undoRefs: (() => void)[] = []

  const out = gatedTreeOp(ws, store, {
    subject: `dreamteamer: modules rename ${oldId} → ${newId}`,
    paths: [...paths],
    mutate: () => {
      // 1. the module's own record refs, BEFORE the folder moves — `store.rewriteRefsBatch`
      //    resolves each collection's directory from the descriptors the Store was built with,
      //    and those are still correct until compile re-runs.
      const refs = store.rewriteRefs(`modules/${oldId}`, `modules/${newId}`)
      undoRefs.push(refs.restore)
      rewrites += refs.rewrites
      for (const f of refs.touched) paths.add(path.relative(ws.root, f))

      // 2. the folder, then its package.json `name`
      fs.renameSync(oldRoot, newRoot)
      moved = true
      const ownPkg = path.join(newRoot, "package.json")
      const ownBytes = fs.readFileSync(ownPkg)
      snapshots.set(path.join(oldRoot, "package.json"), ownBytes) // restored after the un-move
      const own = JSON.parse(ownBytes.toString("utf8"))
      own.name = newId
      fs.writeFileSync(ownPkg, JSON.stringify(own, null, "\t") + "\n")

      // 3. the WORKSPACE package.json: `workspace_module` when it names this module. `disable`
      //    needs nothing: a `<kind>/<id>` entry names an entity, never its module, and a module a
      //    `modules/<id>` entry drops is never discovered, so it cannot be the one renamed here.
      //    SNAPSHOTTED FIRST — editWorkspacePkg writes, so capturing the pre-image afterwards is
      //    impossible.
      snap(path.join(ws.root, "package.json"))
      const wsFile = editWorkspacePkg(ws, dt => {
        if (dt.workspace_module === oldId) dt.workspace_module = newId
      })
      paths.add(path.relative(ws.root, wsFile))

      // 4. every OTHER module's `dreamteamer.dependencies` naming it. peer_collections names
      //    collections and is untouched.
      for (const r of moduleRows(store)) {
        if (r.id === oldId || r.fields.location === "node_modules") continue
        const f = path.join(ws.root, r.fields.path, "package.json")
        if (!fs.existsSync(f)) continue
        const dt = JSON.parse(fs.readFileSync(f, "utf8")).dreamteamer ?? {}
        if (!(dt.dependencies ?? []).includes(oldPkgName)) continue
        snap(f)
        editModulePkg(f, d => {
          d.dependencies = d.dependencies.map(n => (n === oldPkgName ? newId : n))
        })
        paths.add(path.relative(ws.root, f))
        rewrites++
      }

      return { paths: [...paths] }
    },
    undo: () => {
      for (const u of [...undoRefs].reverse()) u()
      if (moved && fs.existsSync(newRoot)) fs.renameSync(newRoot, oldRoot)
      for (const [f, bytes] of snapshots) {
        fs.mkdirSync(path.dirname(f), { recursive: true })
        fs.writeFileSync(f, bytes)
      }
      // re-read the workspace package.json into ws.pkg, whatever it now says on disk
      editWorkspacePkg(ws, () => {})
    },
  })
  return { renamed: true, id: newId, files: out.paths ?? [], rewrites, commits: out.commits }
}
