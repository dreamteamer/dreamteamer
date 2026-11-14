import path from "node:path"
import { baseDescriptorSource } from "../../lib/baseDescriptorSource.ts"
import { collectionSourceFile } from "../../lib/collectionSourceFile.ts"
import { mixinDeclaring } from "./mixinDeclaring.ts"
import { readYaml } from "../../lib/schema-ops.ts"
import { INJECTED } from "./consts.ts"
import { IN_NODE_MODULES } from "../../lib/consts.ts"
import type { Store } from "../../record/Store.ts"
import { fieldsOf } from "../../record/descriptor.ts"
import type { Workspace } from "../../types.ts"

/**
 * THE SOURCE THAT DECLARES AN EXISTING FIELD — the one `set-field` and `rm-field` edit.
 *
 * The base when it declares it; the one overlay that does when the base does not (a field another
 * module added); `--module` to choose between a base and an overlay that both do. A field a mixin
 * contributes is refused, because the mixin is shared by every collection listing it, and an
 * injected field has no source at all.
 */
export function declaringSource(
  ws: Workspace,
  store: Store,
  collection: string,
  fieldName: string,
  moduleId: string | null | undefined,
  verb: string
) {
  if (INJECTED.has(fieldName))
    throw new Error(
      `"${fieldName}" is injected by the engine into every collection — no source declares it, so ${verb} cannot edit it`
    )
  if (!fieldsOf(store.descriptor(collection))[fieldName]) throw new Error(`no field "${fieldName}" on ${collection}`)
  if (moduleId !== undefined && moduleId !== null && moduleId !== "") {
    return collectionSourceFile(ws, store, collection, moduleId, {
      subject: `${collection}.${fieldName}`,
      allowNew: verb === "set-field",
    })
  }
  const { base, overlays } = baseDescriptorSource(ws, collection)
  const declares = (rel: string | undefined): boolean =>
    !!rel && readYaml(path.join(ws.root, rel))?.fields?.[fieldName] !== undefined
  if (declares(base) && !IN_NODE_MODULES(base)) return { file: path.join(ws.root, base), overlay: false }
  const own = overlays.filter(declares)
  if (own.length > 1)
    throw new Error(`${collection}.${fieldName} is declared by ${own.join(", ")} — say which with --module <m>`)
  if (own.length === 1 && !IN_NODE_MODULES(own[0])) return { file: path.join(ws.root, own[0]), overlay: true }
  const mixin = mixinDeclaring(ws, store, collection, fieldName)
  if (mixin)
    throw new Error(
      `${collection}.${fieldName} comes from mixin "${mixin.id}" (${mixin.rel}), which every collection listing it shares — edit the mixin, or declare the field on ${collection} itself`
    )
  if (verb === "rm-field")
    throw new Error(
      `${collection}.${fieldName} is declared by ${base ?? own[0] ?? "a source this workspace cannot rewrite"}, which ships from node_modules — an overlay can override a field there, never remove it`
    )
  // declared only where `npm install` would erase a write: an override in an overlay is the remedy
  return collectionSourceFile(ws, store, collection, undefined, { subject: `${collection}.${fieldName}` })
}
