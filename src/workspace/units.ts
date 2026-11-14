import type { Workspace } from "../types.ts"
import type { DrivenUnit } from "./types.ts"

// ---- the workspace side -----------------------------------------------------------------------

/** Every setup unit the loaded extensions contribute, with its package. */
export const units = (ws: Workspace): DrivenUnit[] =>
  (ws.extensions ?? []).flatMap(e =>
    (e.setup ?? []).map(u => ({
      ...u,
      module: e.name,
      dir: e.dir,
      declared: new Set([...(e.env ?? []), ...(e.vars ?? [])]),
    }))
  )
