import path from "node:path"
import { entityShape, moduleRecord } from "../../lib/schema-ops.ts"
import type { Store } from "../../store/Store.ts"
import type { Workspace } from "../../types.ts"

/**
 * `add` on a kind nobody can scaffold honestly — refused WITH THE PATH, because "hand-authored"
 * without the filename is a refusal the reader has to go research.
 */
export function refuseHandAuthored(ws: Workspace, store: Store, kind: string, id: string, moduleId?: string | null) {
  const shape = entityShape(ws, kind)
  const root = moduleId
    ? moduleRecord(store, moduleId).fields.path
    : path.join("modules", ws.pkg.dreamteamer?.workspace_module ?? "default")
  const where = path.join(root, kind, `${id || "<id>"}${shape.suffix}`)
  const one = kind.replace(/s$/, "")
  throw new Error(
    `${/^[aeiou]/.test(one) ? "an" : "a"} ${one} is hand-authored — its whole value is what you write in it, and a scaffold would produce a file whose only content is that a verb made it.\n  write ${where}, then run \`dreamteamer compile\`.\n  edit an existing one with: dreamteamer set ${kind}/<id> <key>=<value>`
  )
}
