import fs from "node:fs"
import path from "node:path"
import { tempPrefix } from "./env-write.ts"

/** Temporary files an interrupted write of `target` left beside it — a reason to stop and name them. */
export function leftoverTemps(target: string): string[] {
  try {
    return fs
      .readdirSync(path.dirname(target))
      .filter(f => f.startsWith(tempPrefix(target)) && f.endsWith(".tmp"))
      .sort()
  } catch {
    return []
  }
}
