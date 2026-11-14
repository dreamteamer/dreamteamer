import path from "node:path"
import fs from "node:fs"
import { gatedTreeOp } from "../lib/gatedTreeOp.ts"
import { editModulePkg, moduleRecord } from "../lib/schema-ops.ts"
import type { Store } from "../record/Store.ts"
import { storageOf } from "../record/storageOf.ts"
import type { Workspace } from "../types.ts"
import { moduleRows } from "../workspace/moduleRows.ts"

/** A module's own package.json, absolute. */
function modulePkgFile(ws: Workspace, store: Store, id: string): string {
  return path.join(ws.root, moduleRecord(store, id).fields.path, "package.json")
}

export function removeModule(
  ws: Workspace,
  store: Store,
  id: string,
  { force = false, dryRun = false }: { force?: boolean; dryRun?: boolean } = {}
) {
  const { fields } = moduleRecord(store, id)
  if (fields.location === "node_modules") {
    throw new Error(
      `module "${id}" is installed by npm (${fields.path}) — remove it from package.json dependencies and run \`npm install\`; a delete under node_modules/ is erased by the next install.`
    )
  }
  if (fields.location === "git_modules") {
    throw new Error(
      `module "${id}" is a clone under ${fields.path}, and its package.json lives in ANOTHER repo — remove it from dreamteamer.git_modules and delete the clone. This verb removes inline modules only.`
    )
  }
  if (ws.pkg.dreamteamer?.workspace_module === id) {
    throw new Error(
      `module "${id}" IS this workspace's own module (dreamteamer.workspace_module) — removing it would leave the workspace with no sources of its own. Point workspace_module at another module first.`
    )
  }
  const shipped = (fields.collections ?? []).map(r => String(r).replace(/^collections\//, "")).sort()
  // A collection the module OWNS (`owns_data`, or its own `storage.owner: module`) keeps its records
  // inside the module folder, so removing the sources would take the records with them.
  const inside = shipped.filter(
    c =>
      store.descriptors.has(c) &&
      `${storageOf(store.descriptor(c)).path}/`.startsWith(`${fields.path}/`) &&
      store.ids(c).size > 0
  )
  if (inside.length) {
    throw new Error(
      `module "${id}" keeps the records of ${inside.join(", ")} INSIDE ${fields.path}/data — removing the module would delete them, which this verb never does. Move the records out first (drop owns_data, or the collection's storage.owner).`
    )
  }
  const withRecords = shipped.filter(c => store.descriptors.has(c) && store.ids(c).size > 0)
  // A `dependencies` entry naming this module in ANOTHER module fails the gate compile ("depends
  // on X, which is not installed"), so it goes in the SAME write — otherwise --force is a verb that
  // cannot succeed. peer_collections names COLLECTIONS and needs no edit: a peer whose provider is
  // gone is exactly what `unresolved_peers` exists to excuse.
  const pkgName = fields.name
  const dependents = moduleRows(store)
    .filter(r => r.id !== id && (r.fields.dependencies ?? []).includes(`modules/${id}`))
    .map(r => r.id)
  const plan = {
    collections: shipped,
    withRecords,
    dependents,
    records: 0,
    refs: 0,
    descriptors: shipped.length,
    cleared: 0,
  }
  // ⚠ THE DRY RUN COMES FIRST, BEFORE THE --force REFUSAL. A dry run writes nothing, so refusing
  // it for the want of a flag is pure friction — and it is the WRONG WAY ROUND: the plan is what
  // the operator reads to decide whether `--force` is a thing they want to type.
  if (dryRun) return { ...plan, dryRun: true }
  if (shipped.length && !force) {
    throw new Error(
      `${id} still ships ${shipped.length} collection${shipped.length === 1 ? "" : "s"} (${shipped.join(", ")}), ${withRecords.length} with records. --force removes the sources; records stay and become unindexed.`
    )
  }

  const root = path.join(ws.root, "modules", id)
  // ⚠ STASH, DO NOT DELETE, UNTIL THE COMMIT LANDS. `gatedTreeOp`'s `undo` has to be able to put the
  // whole tree back, and a `rmSync` cannot be undone. `.dreamteamer/` is gitignored and on the same
  // device (a cross-device rename would fail), and compile only ever removes the kind folders and
  // `system/`/`ui/` by name — a dot-prefixed sibling survives it.
  const stash = path.join(ws.root, ".dreamteamer", `.rm-module-${id}`)
  const depFiles = dependents.map(m => modulePkgFile(ws, store, m))
  const depBytes = new Map(depFiles.map(f => [f, fs.readFileSync(f)]))
  fs.rmSync(stash, { recursive: true, force: true })

  let out
  try {
    out = gatedTreeOp(ws, store, {
      subject: `dreamteamer: modules rm ${id}`,
      paths: [path.relative(ws.root, root), ...depFiles.map(f => path.relative(ws.root, f))],
      mutate: () => {
        for (const f of depFiles) {
          editModulePkg(f, dt => {
            dt.dependencies = (dt.dependencies ?? []).filter(n => n !== pkgName)
            if (!dt.dependencies.length) delete dt.dependencies
          })
        }
        fs.mkdirSync(path.dirname(stash), { recursive: true })
        fs.renameSync(root, stash)
      },
      undo: () => {
        if (fs.existsSync(stash)) fs.renameSync(stash, root)
        for (const [f, bytes] of depBytes) fs.writeFileSync(f, bytes)
      },
    })
  } finally {
    fs.rmSync(stash, { recursive: true, force: true })
  }
  return { removed: id, ...plan, commits: out.commits }
}
