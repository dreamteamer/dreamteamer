import type { Descriptor } from "../../types.ts"
import fs from "node:fs"
import { storageOf } from "../../record/storageOf.ts"
import path from "node:path"
import { walk } from "../../lib/walk.ts"
import { idFromRecordPath } from "../../record/idFromRecordPath.ts"
import type { Store } from "../Store.ts"

export function* walkRoot(store: Store, d: Descriptor, root: string): Generator<[id: string, file: string]> {
  if (!fs.existsSync(root)) return
  if (storageOf(d).shape === "folder") {
    for (const e of fs.readdirSync(root).sort()) {
      if (e.startsWith(".")) continue
      const main = path.join(root, e, storageOf(d).entry ?? "SKILL.md")
      if (fs.existsSync(main)) yield [e, main]
    }
    return
  }
  for (const f of walk(root)) {
    const id = idFromRecordPath(d, path.relative(root, f))
    if (id !== null) yield [id, f]
  }
}
