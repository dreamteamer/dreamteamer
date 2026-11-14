import path from "node:path"
import fs from "node:fs"
import { baseDescriptorSource } from "./baseDescriptorSource.ts"
import { IN_NODE_MODULES } from "./schema-ops.ts"
import type { Store } from "../record/Store.ts"
import { storageOf } from "../record/storageOf.ts"
import type { Workspace } from "../types.ts"
import { writeGated } from "../workspace/writeGated.ts"

export function removeCollection(
  ws: Workspace,
  store: Store,
  name: string,
  { force = false }: { force?: boolean } = {}
) {
  const d = store.descriptor(name)
  // The module that SHIPS it, not the workspace module. Refusing every module-shipped collection
  // made this verb unusable for exactly the workspace it was built for: a vault's domain
  // collections almost always live in a module.
  const { base, overlays } = baseDescriptorSource(ws, name)
  if (!base) {
    throw new Error(
      `"${name}" has no writable descriptor source — the manifest names none under a module in this workspace. It may be contributed by the engine itself; add "collections/${name}" to dreamteamer.disable instead.`
    )
  }
  if (IN_NODE_MODULES(base)) {
    throw new Error(
      `"${name}" ships from node_modules (${base}) — a write there is erased by the next \`npm install\`. Add "collections/${name}" to dreamteamer.disable instead.`
    )
  }
  // An overlay with no base fails compile ("every source declares `overlay: true` — no base found"),
  // so removing the base under a live overlay is a half-migration that cannot compile.
  if (overlays.length) {
    throw new Error(
      `"${name}" is overlaid by ${overlays.join(", ")} — an overlay cannot compile without its base, so removing the base alone would break the workspace. Remove the overlay first: dreamteamer rm-field ${name} --module <overlay-module> --name <field> (removing its last field removes the overlay).`
    )
  }
  const dest = path.join(ws.root, base)
  const storage = storageOf(d)
  const dataDir = path.resolve(ws.root, storage.path) // resolve: an env-pointed root is absolute
  // the index, not only the folder: a collection stored UNDER another keeps most of its records
  // inside the parent's folders, where a readdir of its own root sees nothing
  const hasRecords =
    store.ids(name).size > 0 || (fs.existsSync(dataDir) && fs.readdirSync(dataDir).some(e => !e.startsWith(".")))
  if (hasRecords && !force)
    throw new Error(
      `collection "${name}" still has records under ${storage.path}${storage.under ? ` and inside ${storage.under.collection} folders` : ""} — remove them first or pass force`
    )
  for (const c of store.descriptors.values()) {
    if (storageOf(c).under?.collection === name)
      throw new Error(
        `collection "${c.name}" stores its records under ${name}'s folders (storage.under) — drop that declaration or relocate its records first; removing the parent would strand them`
      )
  }
  const gate = writeGated(ws, store, [dest], `dreamteamer: collections rm ${name}`, () => fs.rmSync(dest), undefined, {
    commentsMayDecrease: true,
  })
  return { removed: name, commits: gate.commits }
}
