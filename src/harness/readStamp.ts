import { readFileSync } from "node:fs"
import { join } from "node:path"
import { asObject } from "../lib/asObject.ts"
import { asStrings } from "../lib/asStrings.ts"

/** what the last compile recorded in `.dt/stamp.json` — each source's hash, and the harness files it delivered */
export function readStamp(root: string) {
  const file = join(root, ".dt", "stamp.json")
  try {
    const o = asObject(JSON.parse(readFileSync(file, "utf8")), file)
    const res = { sources: asObject(o.sources, file), outputs: asStrings(o.outputs, file) }
    return res
  } catch {
    // none, or unreadable: nothing was recorded, and the next compile writes it anew
    return undefined
  }
}
