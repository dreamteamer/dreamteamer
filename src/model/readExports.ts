import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { asObject } from "../lib/asObject.ts"
import { asOptional } from "../lib/asOptional.ts"
import { messageOf } from "../lib/messageOf.ts"
import type { Issue } from "../types/Issue.ts"

/** the ids another repo vouches for, from `dreamteamer-exports.json`: collection → ids */
export function readExports(root: string, issues: Issue[]): Record<string, string[]> {
  const file = join(root, "dreamteamer-exports.json")
  if (!existsSync(file)) return {}
  try {
    const json = asObject(JSON.parse(readFileSync(file, "utf8")), "the manifest")
    const refs = asOptional(json.references, "references", asObject) ?? {}
    return Object.fromEntries(
      Object.entries(refs).map(([c, ids]) => [c, Object.keys(asObject(ids, `references.${c}`))]),
    )
  } catch (e) {
    issues.push({ severity: "error", where: file, message: `unreadable: ${messageOf(e)}` })
    return {}
  }
}
