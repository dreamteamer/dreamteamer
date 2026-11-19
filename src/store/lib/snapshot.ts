import fs from "node:fs"
import path from "node:path"
import { walk } from "../../lib/walk.ts"
import type { Undo } from "../types.ts"

/**
 * Byte snapshot of a set of files OR DIRECTORIES, and a restore closure. The undo mechanism
 * schema-ops has used for source writes since it was written (schema-ops.js:20). Record writes used
 * `git checkout HEAD -- <paths>` instead, which is only correct while HEAD is guaranteed to be
 * the last good state — it is not, once writes stop committing, and it silently discarded
 * uncommitted hand-edits even before that.
 *
 * A DIRECTORY unit is snapshotted recursively. It used to be skipped with a comment arguing the case
 * could not occur — the only folder-shape collection was `skills`, which is system-stored, so
 * `writableDescriptor` refused before `rm` was reached. That reasoning was true and is the wrong kind
 * of true: it depended on a fact about the CURRENT set of collections rather than on anything the code
 * enforces, and `shape: folder` is an ordinary descriptor option any workspace can choose. The failure
 * it left behind was silent and total — `rm` would delete the folder and the "restore" closure would
 * do nothing, so a failed commit meant the record was simply gone. Twelve lines, no such hole.
 */
export function snapshot(units: string[]): Undo {
  const snaps = units.map(u => {
    const existed = fs.existsSync(u)
    const isDir = existed && fs.statSync(u).isDirectory()
    return {
      u,
      existed,
      isDir,
      prev: existed && !isDir ? fs.readFileSync(u) : null,
      tree: isDir ? snapshotTree(u) : null,
    }
  })
  return () => {
    for (const { u, prev, tree, existed, isDir } of snaps) {
      if (!existed) {
        fs.rmSync(u, { force: true, recursive: true })
        continue
      }
      if (isDir) {
        fs.rmSync(u, { force: true, recursive: true }) // partial state from a failed op
        fs.mkdirSync(u, { recursive: true })
        for (const [rel, bytes] of tree) {
          const dest = path.join(u, rel)
          fs.mkdirSync(path.dirname(dest), { recursive: true })
          fs.writeFileSync(dest, bytes)
        }
        continue
      }
      if (prev !== null) {
        fs.mkdirSync(path.dirname(u), { recursive: true })
        fs.writeFileSync(u, prev)
      }
    }
  }
}

/** Every file under `dir` as [relative path, bytes] — the whole of a folder-shape record. */
function snapshotTree(dir: string): [rel: string, bytes: Buffer][] {
  const out: [string, Buffer][] = []
  for (const file of walk(dir)) out.push([path.relative(dir, file), fs.readFileSync(file)])
  return out
}
