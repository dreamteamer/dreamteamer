import { DtError } from "../lib/DtError.ts"
import type { Model } from "../types/Model.ts"

/** refuse to change any record while the workspace model has errors */
export function refuseBroken(model: Model) {
  const blocking = model.issues.filter((t) => t.severity === "error")
  if (blocking.length)
    throw new DtError("the workspace model has errors — nothing written; fix them first (check lists them)", blocking)
}
