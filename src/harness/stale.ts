import type { Issue } from "../types/Issue.ts"
import type { Model } from "../types/Model.ts"
import { readStamp } from "./readStamp.ts"
import { sourceHashes } from "./sourceHashes.ts"

/** a warning when a source changed, appeared or went away since the last compile; none before the first */
export function stale(model: Model): Issue[] {
  const was = readStamp(model.root)?.sources
  if (!was) return []
  const now = sourceHashes(model)
  const differ = [...new Set([...Object.keys(was), ...Object.keys(now)])].filter((t) => was[t] !== now[t]).sort()
  const named = `${differ.slice(0, 3).join(", ")}${differ.length > 3 ? ", …" : ""}`
  const message = `stale — ${differ.length} source(s) differ since the last compile (${named}); run compile`
  const res: Issue[] = differ.length ? [{ severity: "warning", where: ".dt", message }] : []
  return res
}
