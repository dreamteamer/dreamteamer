import path from "node:path"
import fs from "node:fs"
import { entitySource } from "./lib/entitySource.ts"
import { gatedTreeOp } from "../lib/gatedTreeOp.ts"
import { refuseNpmEntity } from "../lib/schema-ops.ts"
import type { Store } from "../store/Store.ts"
import type { Workspace } from "../types.ts"

export function removeEntity(ws: Workspace, store: Store, kind: string, id: string) {
  const { dir, shipped } = entitySource(ws, kind, id)
  if (!shipped) throw new Error(`${kind.replace(/s$/, "")} "${id}" does not exist — dt list ${kind}`)
  refuseNpmEntity(kind, id, shipped)
  // ⚠ STASH, DO NOT DELETE, UNTIL THE COMMIT LANDS — `gatedTreeOp`'s `undo` has to be able to put a
  // whole folder back, and a `rmSync` cannot be undone. Same reasoning as `removeModule`.
  const stash = path.join(ws.root, ".dreamteamer", `.rm-${kind}-${id}`)
  fs.rmSync(stash, { recursive: true, force: true })
  try {
    const out = gatedTreeOp(ws, store, {
      subject: `dreamteamer: ${kind} rm ${id}`,
      paths: [path.relative(ws.root, dir)],
      mutate: () => {
        fs.mkdirSync(path.dirname(stash), { recursive: true })
        fs.renameSync(dir, stash)
      },
      undo: () => {
        if (fs.existsSync(stash)) fs.renameSync(stash, dir)
      },
    })
    return { removed: id, file: dir, commits: out.commits }
  } finally {
    fs.rmSync(stash, { recursive: true, force: true })
  }
}
