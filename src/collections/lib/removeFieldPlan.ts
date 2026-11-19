import path from "node:path"
import { declaringSource } from "./declaringSource.ts"
import { fieldRenameWalk } from "./fieldRenameWalk.ts"
import { declaringModules, readYaml } from "../../lib/schema-ops.ts"
import type { Position } from "../../lib/types.ts"
import type { Store } from "../../store/Store.ts"
import { bodyFieldOf } from "../../record/descriptor.ts"
import { parseRecord } from "../../record/records.ts"
import type { Workspace } from "../../types.ts"

/**
 * The positions in the edited source that are the field's OWN presentation — removing the field is
 * an explicit act, and pruning these is what it means. Everything else naming it is refused.
 */
const PRUNED_WITH_THE_FIELD =
  /^display\.(list\.(columns|sort|options\.[a-z_]+)|record\.(badge|color_by)|form\.sections\[\d+\])$/

/**
 * What `rm-field` would do, counted without writing: the values it clears, the presentation it
 * prunes, and every position elsewhere that still names the field — which it refuses on.
 */
export function removeFieldPlan(
  ws: Workspace,
  store: Store,
  collection: string,
  fieldName: string,
  { moduleId }: { moduleId?: string } = {}
) {
  const { file } = declaringSource(ws, store, collection, fieldName, moduleId, "rm-field")
  const rel = path.relative(ws.root, file)
  if (readYaml(file)?.fields?.[fieldName] === undefined)
    throw new Error(
      `${rel} does not declare ${collection}.${fieldName} — it is declared by ${declaringModules(ws, store, collection).join(", ")}; drop --module, or name the module whose source declares it`
    )
  // the same walk a rename makes, to a name nothing can hold: every position it reaches names the field
  const { positions } = fieldRenameWalk(ws, store, collection, fieldName, `${fieldName}\u0000`, { records: false })
  const own = (p: Position): boolean =>
    p.rel === rel && (p.at === `fields.${fieldName}` || PRUNED_WITH_THE_FIELD.test(p.at))
  // another source declaring the field keeps it alive — an override removed from an overlay, say —
  // so nothing naming it dangles and its values stay
  const survives = positions.some(p => p.rel !== rel && p.at === `fields.${fieldName}`)
  const blocking = survives
    ? []
    : positions
        .filter(p => !own(p))
        .map(p => ({ ...p, fixed: false, why: p.why ?? "it would name a field that no longer exists" }))
  const d = store.descriptor(collection)
  let cleared = 0
  if (!survives && store.canRewrite(collection)) {
    const bf = bodyFieldOf(d)
    for (const [, f] of store.ids(collection)) {
      try {
        if (fieldName in parseRecord(f, d, bf)) cleared++
      } catch {
        /* `check` reports it */
      }
    }
  }
  return {
    collection,
    field: fieldName,
    file,
    positions: positions.filter(own),
    blocking,
    records: cleared,
    refs: 0,
    descriptors: 1,
    cleared,
  }
}
