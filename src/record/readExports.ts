import path from "node:path"
import fs from "node:fs"
import { EXPORTS_FILE } from "./consts.ts"
import type { ExportRefs } from "./types.ts"

export function readExports(dir: string): ExportRefs | null {
  const file = path.join(dir, EXPORTS_FILE)
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")).references ?? {}
  } catch (e) {
    throw new Error(
      `${EXPORTS_FILE} does not parse (${e.message}) — resolve it by hand: keep every entry line of both sides, then run dt exports`,
      { cause: e }
    )
  }
}
