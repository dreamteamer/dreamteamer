import fs from "node:fs"
import path from "node:path"

const JUNK_DIRS = new Set(["__pycache__", "node_modules"])

const JUNK_FILE = /\.(pyc|pyo)$|^\.DS_Store$/

// THE collection walk — junk-excluding everywhere (store/check used to see .pyc files
// compile deliberately skipped; one walk, one verdict).
export function* walk(dir: string): Generator<string> {
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.startsWith(".") || JUNK_DIRS.has(name)) continue
    if (JUNK_FILE.test(name)) continue
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) yield* walk(p)
    else yield p
  }
}
