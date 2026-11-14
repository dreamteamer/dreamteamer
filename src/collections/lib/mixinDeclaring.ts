import path from "node:path"
import { mixinSources } from "./mixinSources.ts"
import { mixinsListedBy } from "./mixinsListedBy.ts"
import { readYaml } from "../../lib/schema-ops.ts"
import type { Store } from "../../record/Store.ts"
import type { Workspace } from "../../types.ts"

/** The mixin a collection takes `fieldName` from, or null. */
export function mixinDeclaring(
  ws: Workspace,
  store: Store,
  collection: string,
  fieldName: string
): { id: string; rel: string } | null {
  const listed = mixinsListedBy(ws, collection)
  for (const { id, file } of mixinSources(store)) {
    if (listed.has(id) && readYaml(file)?.fields?.[fieldName] !== undefined)
      return { id, rel: path.relative(ws.root, file) }
  }
  return null
}
