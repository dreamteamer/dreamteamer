import fs from "node:fs"
import { uiViewSourceFile } from "./schema-ops.ts"
import type { Store } from "../record/Store.ts"
import type { Workspace } from "../types.ts"
import { writeGated } from "../workspace/writeGated.ts"

export function removeUiView(ws: Workspace, store: Store, id: string) {
  // Same source resolution as the save above — an inline module's view is under this repo's git
  // history like everything else, so deleting it is one revertable commit. Refusing it while
  // ALLOWING a save to the same file would be an asymmetry with nothing behind it.
  const { file: dest, shipped } = uiViewSourceFile(ws, id)
  if (shipped && /(^|\/)node_modules\//.test(shipped))
    throw new Error(
      `ui-view "${id}" is shipped by an installed package (${shipped}) — removing the file would be undone by the next npm install.\n  disable it instead: add "ui-views/${id}" to dreamteamer.disable in package.json.`
    )
  if (!fs.existsSync(dest)) throw new Error(`ui-view "${id}" does not exist`)
  const gate = writeGated(ws, store, [dest], `dreamteamer: ui-views rm ${id}`, () => fs.rmSync(dest), undefined, {
    commentsMayDecrease: true,
  })
  return { removed: id, commits: gate.commits }
}
