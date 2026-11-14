import path from "node:path"
import fs from "node:fs"
import { renameKeys } from "./renameKeys.ts"
import type { RecordRewrite, SourceEdit } from "./types.ts"
import { atomicWrite } from "../record/atomicWrite.ts"
import { serialize } from "../record/serialize.ts"
import { writeSource } from "../record/writeSource.ts"
import { commentCount, load } from "../record/yaml.ts"
import type { Descriptor, Workspace } from "../types.ts"
import type { SourceDoc } from "../workspace/types.ts"

/** Write a walk's rewritten documents and records, inside a gate op; returns the touched paths. */
export function applyRewrites(
  ws: Workspace,
  edits: Map<string, SourceEdit>,
  records: RecordRewrite[],
  cd: Descriptor,
  snap: (f: string) => unknown
): Set<string> {
  const touched = new Set<string>()
  for (const [file, { before, doc, keys }] of edits) {
    const after = writeSource(keys.length ? renameKeys(before, keys) : before, doc)
    if (!load<SourceDoc | null>(after) || commentCount(after) < commentCount(before)) {
      throw new Error(
        `could not rewrite ${path.relative(ws.root, file)} without losing a comment — nothing was changed.`
      )
    }
    snap(file)
    fs.writeFileSync(file, after)
    touched.add(path.relative(ws.root, file))
  }
  for (const { file, fields, text } of records) {
    snap(file)
    atomicWrite(file, serialize(cd, fields, text))
    touched.add(path.relative(ws.root, file))
  }
  return touched
}
