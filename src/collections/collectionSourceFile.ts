import path from "node:path"
import { baseDescriptorSource } from "./baseDescriptorSource.ts"
import { declaringModules, moduleRecord, workspaceSystemDir } from "./schema-ops.ts"
import { IN_NODE_MODULES } from "./consts.ts"
import type { Store } from "../record/Store.ts"
import type { Workspace } from "../types.ts"
import { kindDir } from "../workspace/compile.ts"

/**
 * WHERE A FIELD VERB WRITES. The base descriptor's own file when this workspace may rewrite it; the
 * named module's overlay when a selector says so; the workspace module's overlay when neither.
 *
 * ⚠ The guard is `node_modules/`, NOT "which module" — that is the line `descriptorSourceDir`
 * already drew for `renameCollection` and the reason it drew it: the thing that erases a write is
 * `npm install`, and a module whose sources are inline in the workspace repo is under the same git
 * history as everything else. Resolving this from `workspaceSystemDir` instead meant a field verb on
 * ANY other inline module's collection silently created an overlay in the workspace module and then
 * failed compile for a dependency the operator never asked to declare.
 *
 * ⚠ `moduleId` IS A SELECTOR, NOT A DESTINATION. Naming the owner is redundant and naming a module
 * that contributes nothing is the DEFECT this wave exists to remove: `upsertField` used to create an
 * overlay wherever it was pointed, silently. So a selector that selects nothing is refused unless
 * the caller is deliberately creating an overlay, which `allowNew` says out loud.
 */
export function collectionSourceFile(
  ws: Workspace,
  store: Store,
  collection: string,
  moduleId: string | null | undefined,
  { allowNew = false, subject }: { allowNew?: boolean; subject?: string } = {}
) {
  const { base, overlays } = baseDescriptorSource(ws, collection)
  if (moduleId !== undefined && moduleId !== null && moduleId !== "") {
    const rec = moduleRecord(store, moduleId) // throws with the known-module list
    if (IN_NODE_MODULES(rec.fields.path)) {
      throw new Error(
        `module "${moduleId}" ships from node_modules (${rec.fields.path}) — a write there is erased by the next \`npm install\`.\n  to add fields from this workspace: dreamteamer add-field ${collection} --name <f> --module ${ws.pkg.dreamteamer?.workspace_module ?? "default"}`
      )
    }
    // ⚠ A SELECTOR SELECTS AMONG THINGS. `--module` is only meaningful where the entity is
    // declared by MORE than one module (a base plus overlays); anywhere else it is refused (§5),
    // naming who does declare it. `allowNew` is the one caller deliberately CREATING an overlay.
    const declared = declaringModules(ws, store, collection)
    // naming the ONLY declarer is redundant even where an overlay may be created: it selects the base
    if (declared.length < 2 && (!allowNew || declared.includes(moduleId))) {
      throw new Error(`${subject ?? collection} is declared only by ${declared.join(", ") || "?"} — drop --module`)
    }
    const own = [base, ...overlays].find(p => p && String(p).startsWith(`${rec.fields.path}/`))
    if (own) return { file: path.join(ws.root, own), overlay: own !== base, module: moduleId }
    if (!allowNew) {
      throw new Error(
        `module "${moduleId}" contributes no source to ${collection} — it is declared by ${declared.join(", ") || "nothing in this workspace"}. To ADD fields from ${moduleId}: dreamteamer add-field ${collection} --name <f> --module ${moduleId}`
      )
    }
    return {
      file: path.join(kindDir(path.join(ws.root, rec.fields.path), "collections"), `${collection}.collection.yaml`),
      overlay: true,
      module: moduleId,
    }
  }
  if (base && !IN_NODE_MODULES(base)) return { file: path.join(ws.root, base), overlay: false, module: null }
  return {
    file: path.join(workspaceSystemDir(ws, "collections"), `${collection}.collection.yaml`),
    overlay: true,
    module: null,
  }
}
