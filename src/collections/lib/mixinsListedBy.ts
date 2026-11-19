import path from "node:path"
import { baseDescriptorSource } from "../../lib/baseDescriptorSource.ts"
import { readYaml } from "../../lib/schema-ops.ts"
import type { Workspace } from "../../types.ts"

/** The mixins a collection's sources list. */
export function mixinsListedBy(ws: Workspace, collection: string): Set<string> {
  const { base, overlays } = baseDescriptorSource(ws, collection)
  const ids = new Set<string>()
  for (const rel of [base, ...overlays].filter(Boolean)) {
    const doc = readYaml(path.join(ws.root, rel))
    for (const m of Array.isArray(doc?.mixins) ? doc.mixins : []) ids.add(String(m))
  }
  return ids
}
