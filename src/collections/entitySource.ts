import path from "node:path"
import { entityShape } from "./schema-ops.ts"
import { readManifest } from "../runtime/runtime.ts"
import type { Workspace } from "../types.ts"

/** The source file (or folder) ONE entity is compiled from, asked of the manifest — the same
 *  question `uiViewSourceFile` asks, for the five other kinds. */
export function entitySource(
  ws: Workspace,
  kind: string,
  id: string
): { file: string | null; dir: string | null; shipped: string | null } {
  const shape = entityShape(ws, kind)
  const key = shape.folder ? `${kind}/${id}/SKILL.md` : `${kind}/${id}${shape.suffix}`
  const src = readManifest(ws.root)?.entries?.[key]?.sources?.[0]
  const shipped = typeof src === "string" ? src : src?.path
  if (!shipped) return { file: null, dir: null, shipped: null }
  const file = path.join(ws.root, shipped)
  return { file, dir: shape.folder ? path.dirname(file) : file, shipped }
}
